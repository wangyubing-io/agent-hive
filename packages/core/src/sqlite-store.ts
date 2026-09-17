// 零依赖长期记忆存储：基于 Node 22 内置 node:sqlite 实现的 BaseStore。
// 为什么需要它：NodeSqliteSaver 是 per-thread 的（thread_id = agentId + cwd 哈希），
//   会话重置 / 换工作区就全没了，团队级「既定事实」（项目约定、踩过的坑、关键决策）
//   无处安放。BaseStore 是 LangGraph 官方的跨线程/跨会话记忆载体，命名空间自由组织。
// 为什么自己写：官方实现 @langchain/langgraph-checkpoint-sqlite 依赖 better-sqlite3（原生模块，
//   需联网下载预编译二进制），违反本项目「完全自包含、零外部依赖」强校验。BaseStore 只有
//   batch() 是抽象方法（get/put/search/delete/listNamespaces 都由基类走 batch 分发），
//   所以这里只需实现 batch 一条路径。
import "./suppress-warning.ts"; // 必须先于 node:sqlite 加载
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import type { Item, Operation, OperationResults, SearchItem } from "@langchain/langgraph-checkpoint";

/** 长期记忆库文件（与 agent-sessions.db 同级，随项目目录走） */
export function memoryDbPath(dataDir: string): string {
  return join(dataDir, "agent-memory.db");
}

/** 工作区记忆的命名空间：["workspace", <groupId>] —— 同工作区所有成员共享 */
export function workspaceNamespace(groupId: string): string[] {
  return ["workspace", groupId];
}

interface Row {
  namespace: string;
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

/** SQL LIKE 通配符转义（命名空间 JSON 串里可能含 % _ \） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** 过滤条件求值：支持精确匹配与 $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin（与官方 compareValues 语义一致） */
function matchFilter(value: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  for (const [k, cond] of Object.entries(filter)) {
    const v = value?.[k];
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, ref] of Object.entries(cond as Record<string, unknown>)) {
        const num = (x: unknown) => (typeof x === "number" ? x : Number(x));
        const ok =
          op === "$eq" ? v === ref
          : op === "$ne" ? v !== ref
          : op === "$gt" ? num(v) > num(ref)
          : op === "$gte" ? num(v) >= num(ref)
          : op === "$lt" ? num(v) < num(ref)
          : op === "$lte" ? num(v) <= num(ref)
          : op === "$in" ? (Array.isArray(ref) ? ref.includes(v) : false)
          : op === "$nin" ? (Array.isArray(ref) ? !ref.includes(v) : true)
          : false;
        if (!ok) return false;
      }
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

/** 命名空间匹配条件（与官方 doesMatch 一致：prefix=从头比，suffix=从尾比，"*" 为通配元素） */
function doesMatch(cond: { matchType?: string; path?: string[] }, ns: string[]): boolean {
  const path = cond?.path ?? [];
  if (cond?.matchType === "prefix") {
    if (path.length > ns.length) return false;
    return path.every((p, i) => p === "*" || ns[i] === p);
  }
  if (cond?.matchType === "suffix") {
    if (path.length > ns.length) return false;
    return path.every((p, i) => p === "*" || ns[ns.length - path.length + i] === p);
  }
  return false; // 未知 matchType：不匹配（官方此处抛错，这里静默为不匹配更稳）
}

/**
 * node:sqlite 实现的 BaseStore：命名空间 + 键值的持久化长期记忆。
 * batch() 的 Operation 分发顺序严格对齐官方 InMemoryStore——五个 op 的形状有重叠
 * （get 与 delete 都只有 namespace+key，delete 多了 value:null），顺序错就会把 get 当 delete 执行。
 * --- @ty.aicoding@1789443562072 ---
 */
export class NodeSqliteStore extends BaseStore {
  private db: DatabaseSync;
  private isSetup = false;

  constructor(dbPath: string) {
    super();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
  }

  private static instance: NodeSqliteStore | undefined;
  private static instancePath: string | undefined;
  /** 单例入口：data/agent-memory.db（进程内共享，避免多连接写同库） */
  static getInstance(dbPath: string): NodeSqliteStore {
    if (!NodeSqliteStore.instance || NodeSqliteStore.instancePath !== dbPath) {
      NodeSqliteStore.resetInstance();
      NodeSqliteStore.instance = new NodeSqliteStore(dbPath);
      NodeSqliteStore.instancePath = dbPath;
    }
    return NodeSqliteStore.instance;
  }
  static resetInstance(): void {
    if (NodeSqliteStore.instance) {
      try { NodeSqliteStore.instance.db.close(); } catch { /* 已关闭 */ }
      NodeSqliteStore.instance = undefined;
      NodeSqliteStore.instancePath = undefined;
    }
  }

  private setup(): void {
    if (this.isSetup) return;
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS long_term_memory (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_ltm_updated ON long_term_memory (updated_at DESC)");
    this.isSetup = true;
  }

  /** BaseStore 唯一抽象方法：逐条分发 get / search / put / delete / listNamespaces */
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    this.setup();
    const out = operations.map((op) => this.runOp(op as Operation));
    return out as unknown as OperationResults<Op>;
  }

  // ---------- 领域级便捷 API（remember / recall 工具直接用，避免工具里拼 namespace） ----------

  /** 记住一条（同 key 覆盖），返回是否为更新 */
  remember(groupId: string, key: string, text: string): boolean {
    this.setup();
    const ns = JSON.stringify(workspaceNamespace(groupId));
    const existed = this.db.prepare("SELECT 1 FROM long_term_memory WHERE namespace = ? AND key = ?").get(ns, key) !== undefined;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO long_term_memory (namespace, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(ns, key, JSON.stringify({ text }), now, now);
    return existed;
  }

  /** 列出工作区记忆（新增/更新在前） */
  listWorkspaceMemory(groupId: string, limit = 50): Array<{ key: string; text: string; updatedAt: number }> {
    this.setup();
    const ns = JSON.stringify(workspaceNamespace(groupId));
    const rows = this.db.prepare(
      "SELECT key, value, updated_at FROM long_term_memory WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?"
    ).all(ns, Math.max(1, Math.min(200, limit))) as Array<{ key: string; value: string; updated_at: number }>;
    return rows.map((r) => {
      let text = "";
      try { text = String((JSON.parse(r.value) as { text?: unknown })?.text ?? ""); } catch { text = r.value; }
      return { key: r.key, text, updatedAt: r.updated_at };
    });
  }

  /** 按关键词筛选工作区记忆（key 或正文命中；空关键词=全量） */
  searchWorkspaceMemory(groupId: string, query: string, limit = 20): Array<{ key: string; text: string; updatedAt: number }> {
    const q = (query || "").trim().toLowerCase();
    const all = this.listWorkspaceMemory(groupId, 200);
    if (!q) return all.slice(0, limit);
    return all.filter((m) => m.key.toLowerCase().includes(q) || m.text.toLowerCase().includes(q)).slice(0, limit);
  }

  /** 删除一条记忆 */
  forget(groupId: string, key: string): boolean {
    this.setup();
    const ns = JSON.stringify(workspaceNamespace(groupId));
    const r = this.db.prepare("DELETE FROM long_term_memory WHERE namespace = ? AND key = ?").run(ns, key);
    return r.changes > 0;
  }

  /** 工作区记忆条数（供 UI/日志） */
  countWorkspaceMemory(groupId: string): number {
    this.setup();
    const ns = JSON.stringify(workspaceNamespace(groupId));
    return (this.db.prepare("SELECT count(*) AS n FROM long_term_memory WHERE namespace = ?").get(ns) as { n: number }).n;
  }

  // ---------- Operation 分发 ----------
  // 分发顺序严格对齐官方 InMemoryStore.batch（顺序就是语义，写错会把 get 当成 delete）：
  //   get    → { namespace, key }                  （无 value 字段）
  //   search → { namespacePrefix, filter?, limit?, offset?, query? }
  //   put    → { namespace, key, value }            （value === null 即"删除"，见 delete()）
  //   delete → { namespace, key, value: null }
  //   list   → { matchConditions?, maxDepth?, limit?, offset? }（不是 prefix/suffix 两个字段）

  private runOp(op: Operation): unknown {
    if ("key" in op && "namespace" in op && !("value" in op)) return this.opGet(op as { namespace: string[]; key: string });
    if ("namespacePrefix" in op) return this.opSearch(op);
    if ("value" in op) return this.opPut(op as { namespace: string[]; key: string; value: Record<string, unknown> | null });
    if ("matchConditions" in op) return this.opList(op as { matchConditions?: Array<{ matchType?: string; path?: string[] }>; maxDepth?: number; limit?: number; offset?: number });
    return null;
  }

  private rowToItem(r: Row): Item {
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(r.value) as Record<string, unknown>; } catch { value = {}; }
    return {
      value,
      key: r.key,
      namespace: JSON.parse(r.namespace) as string[],
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  /** 取单条（不存在返回 null——绝不能误走删除分支） */
  private opGet(op: { namespace: string[]; key: string }): Item | null {
    this.setup();
    const row = this.db
      .prepare("SELECT * FROM long_term_memory WHERE namespace = ? AND key = ?")
      .get(JSON.stringify(op.namespace ?? []), op.key) as Row | undefined;
    return row ? this.rowToItem(row) : null;
  }

  private opSearch(op: { namespacePrefix: string[]; filter?: Record<string, unknown>; limit?: number; offset?: number }): SearchItem[] {
    const rows = this.prefixRows(op.namespacePrefix);
    const items = rows
      .map((r) => this.rowToItem(r))
      .filter((it) => matchFilter(it.value, op.filter));
    const offset = op.offset && op.offset > 0 ? op.offset : 0;
    const limit = op.limit && op.limit > 0 ? op.limit : 10;
    return items.slice(offset, offset + limit);
  }

  /** 命名空间前缀命中（JSON 串前缀匹配；prefix 为空=全库） */
  private prefixRows(prefix: string[]): Row[] {
    this.setup();
    if (!prefix?.length) {
      return this.db.prepare("SELECT * FROM long_term_memory ORDER BY updated_at DESC").all() as unknown as Row[];
    }
    const json = JSON.stringify(prefix); // ["a","b"]
    const like = escapeLike(json.slice(0, -1)) + ",%"; // ["a","b",%
    return this.db.prepare(
      "SELECT * FROM long_term_memory WHERE namespace = ? OR namespace LIKE ? ESCAPE '\\' ORDER BY updated_at DESC"
    ).all(json, like) as unknown as Row[];
  }

  private opPut(op: { namespace: string[]; key: string; value: Record<string, unknown> | null }): void {
    // value === null = delete 语义（官方 delete() 就是 put({value:null})，见 base.js）
    if (op.value === null) {
      this.opDelete(op as { namespace: string[]; key: string });
      return;
    }
    this.setup();
    const ns = JSON.stringify(op.namespace ?? []);
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO long_term_memory (namespace, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(ns, op.key, JSON.stringify(op.value ?? {}), now, now);
  }

  private opDelete(op: { namespace: string[]; key: string }): void {
    this.setup();
    this.db.prepare("DELETE FROM long_term_memory WHERE namespace = ? AND key = ?").run(JSON.stringify(op.namespace ?? []), op.key);
  }

  /** 列出命名空间（matchConditions 前缀/后缀 + maxDepth 收敛；排序与官方一致：字典序） */
  private opList(op: { matchConditions?: Array<{ matchType?: string; path?: string[] }>; maxDepth?: number; limit?: number; offset?: number }): string[][] {
    const rows = this.prefixRows([]); // 命名空间层级浅、行数有限，全量后在内存里筛更简单可靠
    let namespaces = rows.map((r) => JSON.parse(r.namespace) as string[]);
    if (op.matchConditions?.length) {
      const conds = op.matchConditions;
      namespaces = namespaces.filter((ns) => conds.every((c) => doesMatch(c, ns)));
    }
    if (op.maxDepth !== undefined && op.maxDepth > 0) {
      // 收敛到指定深度后去重（官方语义：maxDepth 后同名命名空间合并为一条）
      namespaces = namespaces.map((ns) => ns.slice(0, op.maxDepth));
    }
    const uniq = [...new Map(namespaces.map((ns) => [JSON.stringify(ns), ns])).values()];
    uniq.sort((a, b) => a.join(":").localeCompare(b.join(":")));
    const offset = op.offset && op.offset > 0 ? op.offset : 0;
    const limit = op.limit && op.limit > 0 ? op.limit : uniq.length;
    return uniq.slice(offset, offset + limit);
  }

  close(): void {
    try { this.db.close(); } catch { /* 已关闭 */ }
    if (NodeSqliteStore.instance === this) {
      NodeSqliteStore.instance = undefined;
      NodeSqliteStore.instancePath = undefined;
    }
  }
}
