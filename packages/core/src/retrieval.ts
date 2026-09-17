// 检索层：node:sqlite FTS5（trigram 分词）全文索引——群聊历史 + 工作区文件内容。
// 自包含（Node 22 内置 node:sqlite，零外部依赖，符合本项目强校验）：
// server 启动时对全部群聊与工作目录初始化索引，之后增量维护（新消息落盘即索引、
// agent 产物 diff 后即索引），agent 经 search_history / search_workspace 工具检索
// ——含上下文窗口之外的更早历史，补齐 trimMessages 裁剪丢掉的信息。
//
// 选型背景：zvec-grep / qmd 的向量检索分别依赖 onnxruntime-node（本机 DLL 初始化
// 失败，跨 1.21/1.29 版本）与 node-llama-cpp（需 VS 编译，构建环境缺失）原生运行时，
// 不满足「随项目启动、零外部依赖」；FTS5 trigram 对中文友好（子串级匹配），
// Node 内置、启动即用。后续环境就绪可把本层升级为混合检索（对外接口不变）。
import "./suppress-warning.ts"; // 必须先于 node:sqlite 加载
import { readFileSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeOutput } from "./sandbox.ts";
import type { ChatMsg } from "./types.ts";

/** 文本文件扩展名白名单（其余类型不索引内容，出现在文件区但不参与全文检索） */
const TEXT_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "markdown", "txt", "log",
  "html", "htm", "css", "scss", "less", "py", "go", "rs", "java", "kt", "sql",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "sh", "bash", "bat", "cmd", "ps1",
  "csv", "tsv", "xml", "svg", "vue", "svelte", "rb", "php", "c", "h", "cpp", "hpp",
  "cs", "swift", "dart", "gradle", "properties", "env", "gitignore", "dockerfile",
]);

/** 单文件索引上限：超大的多为数据/产物文件，检索价值低且拖慢索引 */
const MAX_INDEX_BYTES = 256 * 1024;

/** 检索专用噪音目录：除通用忽略外，构建产物/依赖缓存对「找内容」无价值且体量巨大
 *  （实测两个真实仓库 13k 文件首扫 25 分钟，排除产物后大幅缩减） */
const RETRIEVAL_EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".dsh", "dist", "build", "out", ".next", ".nuxt", ".output",
  ".vite", ".turbo", ".cache", "coverage", "target", "vendor", "tmp", ".idea", ".vscode",
]);

/** 疑似压缩/混淆文件判定：内容大且几乎无换行（min.js 等），索引只会产生垃圾 trigram */
function looksMinified(content: string): boolean {
  if (content.length < 10_000) return false;
  const newlines = content.slice(0, 50_000).split("\n").length;
  return newlines < 20; // 5 万字符不到 20 行 → 压缩产物
}

/** 文件内容分块（字符）与块间重叠：查询词跨块边界时仍可命中 */
const CHUNK_CHARS = 1600;
const CHUNK_OVERLAP = 200;

/** 每次检索返回的默认条数上限 */
const DEFAULT_LIMIT = 8;

export interface ChatHit {
  msgId: string;
  sender: string;
  ts: number;
  snippet: string;
}

export interface FileHit {
  agentId: string;
  path: string; // 相对该 agent 工作区根的路径（可直接 read_file）
  snippet: string;
}

/** FTS5 MATCH 查询安全包装：整串作为一个 phrase（trigram 下=子串匹配），
 *  转义内部双引号防注入语法；<3 字符的查询 trigram 无法命中，调用方走 LIKE 兜底 */
function phrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class RetrievalIndex {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    // 防呆：dbPath 已存在且是目录（getRetrieval 误传完整文件路径时会 join 出嵌套路径）→ 明确报错
    try {
      if (statSync(dbPath).isDirectory()) {
        throw new Error(`检索索引路径是一个目录（应为文件）：${dbPath}。getRetrieval 应传数据目录而非 db 文件路径`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // 不存在=正常新建
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    // 索引可从源数据全量重建，不追求掉电安全；WAL + NORMAL 写入吞吐远高于 FULL（实测首扫提速数倍）
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA cache_size=-65536"); // 64MB 页缓存（trigram 索引写入密集）;
    // 群聊消息：每条消息一行（body = 发送人 + 正文 + 附件名，参与 trigram 索引）
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
      groupId UNINDEXED, msgId UNINDEXED, sender UNINDEXED, ts UNINDEXED, body,
      tokenize='trigram')`);
    // 文件内容：每个分块一行（agentId 用于归属展示与重索引定位）
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
      groupId UNINDEXED, agentId UNINDEXED, path UNINDEXED, body,
      tokenize='trigram')`);
    // 已索引消息登记（msgId 主键幂等去重，INSERT OR IGNORE + changes 判定 O(1)）
    this.db.exec(`CREATE TABLE IF NOT EXISTS chat_indexed (
      msgId TEXT PRIMARY KEY, groupId TEXT NOT NULL, ts INTEGER NOT NULL)`);
    // 文件内容变更检测（mtime+size 相同则跳过重读重索引）
    this.db.exec(`CREATE TABLE IF NOT EXISTS file_state (
      absPath TEXT PRIMARY KEY, mtimeMs REAL NOT NULL, size INTEGER NOT NULL, indexedAt INTEGER NOT NULL)`);
  }

  // ---------- 群聊 ----------

  /** 索引消息（幂等：按 msgId 去重，重复调用安全） */
  indexChat(groupId: string, msgs: ChatMsg[]): number {
    let n = 0;
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO chat_indexed (msgId, groupId, ts) VALUES (?, ?, ?)"
    );
    const insFts = this.db.prepare(
      "INSERT INTO chat_fts (groupId, msgId, sender, ts, body) VALUES (?, ?, ?, ?, ?)"
    );
    this.db.exec("BEGIN");
    try {
      for (const m of msgs) {
        if (!m?.id || !m.text?.trim()) continue;
        const r = ins.run(m.id, groupId, m.ts);
        if (r.changes !== 1) continue; // 已索引过
        const body = [
          m.senderName || m.senderId,
          m.text,
          (m.attachments || []).map((a) => a.name).filter(Boolean).join(" "),
        ].filter(Boolean).join("\n");
        insFts.run(groupId, m.id, m.senderName || m.senderId, m.ts, body.slice(0, 8000));
        n++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw e;
    }
    return n;
  }

  /** 删除某群全部聊天索引（删工作区时调用；文件区/消息落盘仍按原策略保留） */
  clearChat(groupId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM chat_fts WHERE groupId = ?").run(groupId);
      this.db.prepare("DELETE FROM chat_indexed WHERE groupId = ?").run(groupId);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw e;
    }
  }

  /**
   * 检索群聊历史（trigram 短语匹配；<3 字符走 LIKE 子串兜底）。
   * snippet 窗口 64：trigram 下每个 token = 一个 trigram，实测 24 → 仅约 30 字符（≈15 汉字），
   * 给到模型的上下文过窄；64 → 约 69 字符，能带上命中词前后的完整一句话。
   * --- @ty.aicoding@1789442083508 ---
   */
  searchChat(groupId: string, query: string, limit = DEFAULT_LIMIT): ChatHit[] {
    const q = query.trim();
    if (!q) return [];
    const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    const sql =
      q.length >= 3
        ? `SELECT msgId, sender, ts, snippet(chat_fts, 4, '', '', '…', 64) AS snip
           FROM chat_fts WHERE chat_fts MATCH ? AND groupId = ? ORDER BY rank LIMIT ?`
        : `SELECT msgId, sender, ts, substr(body, 1, 200) AS snip
           FROM chat_fts WHERE groupId = ? AND body LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?`;
    const rows = (
      q.length >= 3
        ? this.db.prepare(sql).all(phrase(q), groupId, limit)
        : this.db.prepare(sql).all(groupId, like, limit)
    ) as Array<{ msgId: string; sender: string; ts: number; snip: string }>;
    return rows.map((r) => ({ msgId: r.msgId, sender: r.sender, ts: r.ts, snippet: (r.snip || "").trim() }));
  }

  // ---------- 文件 ----------

  /** 索引一个文本文件内容（分块写入；重复调用按 file_state 变更检测跳过） */
  indexFile(groupId: string, agentId: string, absPath: string, relPath: string): boolean {
    let st;
    try {
      st = statSync(absPath);
    } catch {
      return false;
    }
    if (st.size > MAX_INDEX_BYTES) return false;
    if (TEXT_EXTS.has((relPath.split(".").pop() || "").toLowerCase()) === false) {
      // 无扩展名或不在白名单：仅当首 2KB 可解为文本时索引（如 README、Makefile）
      try {
        const head = readFileSync(absPath).subarray(0, 2048);
        new TextDecoder("utf-8", { fatal: true }).decode(head);
      } catch {
        return false; // 二进制
      }
    }
    const prev = this.db.prepare("SELECT mtimeMs, size FROM file_state WHERE absPath = ?").get(absPath) as
      | { mtimeMs: number; size: number }
      | undefined;
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return false; // 未变

    let content: string;
    try {
      content = decodeOutput(readFileSync(absPath));
    } catch {
      return false;
    }
    if (looksMinified(content)) return false; // 压缩/混淆产物：索引只有垃圾 trigram
    if (content.length > 200_000) content = content.slice(0, 200_000); // 保险丝（≤256KB 文本）

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM file_fts WHERE groupId = ? AND agentId = ? AND path = ?").run(groupId, agentId, relPath);
      const ins = this.db.prepare("INSERT INTO file_fts (groupId, agentId, path, body) VALUES (?, ?, ?, ?)");
      for (let i = 0; i < content.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        const chunk = content.slice(i, i + CHUNK_CHARS);
        if (!chunk.trim()) continue;
        ins.run(groupId, agentId, relPath, chunk);
        if (i + CHUNK_CHARS >= content.length) break; // 最后一块
      }
      this.db.prepare(
        "INSERT OR REPLACE INTO file_state (absPath, mtimeMs, size, indexedAt) VALUES (?, ?, ?, ?)"
      ).run(absPath, st.mtimeMs, st.size, Date.now());
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw e;
    }
    return true;
  }

  /** 扫描目录（检索专用排除规则，忽略构建产物/依赖缓存），返回相对路径列表 */
  private scanFiles(root: string, prefix = ""): string[] {
    const out: string[] = [];
    let entries;
    try {
      entries = readdirSync(join(root, prefix), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (RETRIEVAL_EXCLUDE_DIRS.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(...this.scanFiles(root, rel));
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
    return out;
  }

  /** 扫描目录并索引（跳过产物/依赖目录；mtime+size 未变的文件零开销跳过）。
   *  返回 { indexed: 新索引数, scanned: 扫过的文件数 } */
  indexDir(groupId: string, agentId: string, root: string): { indexed: number; scanned: number } {
    let indexed = 0;
    const files = this.scanFiles(root);
    for (const rel of files) {
      try {
        if (this.indexFile(groupId, agentId, join(root, rel), rel)) indexed++;
      } catch {
        /* 单文件失败不影响整体 */
      }
    }
    return { indexed, scanned: files.length };
  }

  /** 异步版 indexDir：每 20 个文件让出主线程（启动全量初始化专用，保证服务不阻塞） */
  async indexDirAsync(groupId: string, agentId: string, root: string): Promise<{ indexed: number; scanned: number }> {
    let indexed = 0;
    const files = this.scanFiles(root);
    for (let i = 0; i < files.length; i++) {
      try {
        if (this.indexFile(groupId, agentId, join(root, files[i]), files[i])) indexed++;
      } catch {
        /* 单文件失败不影响整体 */
      }
      if (i % 20 === 19) await new Promise((r) => setImmediate(r)); // 让出主线程
    }
    return { indexed, scanned: files.length };
  }

  /** 删除某群全部文件索引 */
  clearFiles(groupId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM file_fts WHERE groupId = ?").run(groupId);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw e;
    }
  }

  /**
   * 检索群内文件内容（跨全部成员；命中返回 agentId + 相对路径 + 片段）。
   * snippet 窗口 64（同上：trigram 下 24 只能给到约 15 个汉字，太窄）。
   * --- @ty.aicoding@1789442083508 ---
   */
  searchFiles(groupId: string, query: string, limit = DEFAULT_LIMIT): FileHit[] {
    const q = query.trim();
    if (!q) return [];
    const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    const sql =
      q.length >= 3
        ? `SELECT agentId, path, snippet(file_fts, 3, '', '', '…', 64) AS snip
           FROM file_fts WHERE file_fts MATCH ? AND groupId = ? ORDER BY rank LIMIT ?`
        : `SELECT agentId, path, substr(body, 1, 200) AS snip
           FROM file_fts WHERE groupId = ? AND body LIKE ? ESCAPE '\\' ORDER BY rowid DESC LIMIT ?`;
    const rows = (
      q.length >= 3
        ? this.db.prepare(sql).all(phrase(q), groupId, limit)
        : this.db.prepare(sql).all(groupId, like, limit)
    ) as Array<{ agentId: string; path: string; snip: string }>;
    return rows.map((r) => ({ agentId: r.agentId, path: r.path, snippet: (r.snip || "").trim() }));
  }

  // ---------- 统计（启动日志用） ----------

  stats(): { chatRows: number; fileRows: number; files: number } {
    const chatRows = (this.db.prepare("SELECT count(*) AS n FROM chat_fts").get() as { n: number }).n;
    const fileRows = (this.db.prepare("SELECT count(*) AS n FROM file_fts").get() as { n: number }).n;
    const files = (this.db.prepare("SELECT count(*) AS n FROM file_state").get() as { n: number }).n;
    return { chatRows, fileRows, files };
  }

  close(): void {
    try { this.db.close(); } catch { /* 已关闭 */ }
    // 单例自清：close 后 getInstance 会重建（进程内重开语义，如 shutdown→重启场景）
    if (RetrievalIndex.instance === this) {
      RetrievalIndex.instance = undefined;
      RetrievalIndex.instancePath = undefined;
    }
  }

  // ---------- 单例 ----------

  private static instance: RetrievalIndex | undefined;
  private static instancePath: string | undefined;

  static getInstance(dbPath: string): RetrievalIndex {
    if (!RetrievalIndex.instance || RetrievalIndex.instancePath !== dbPath) {
      RetrievalIndex.resetInstance();
      RetrievalIndex.instance = new RetrievalIndex(dbPath);
      RetrievalIndex.instancePath = dbPath;
    }
    return RetrievalIndex.instance;
  }

  static resetInstance(): void {
    if (RetrievalIndex.instance) {
      RetrievalIndex.instance.close();
      RetrievalIndex.instance = undefined;
      RetrievalIndex.instancePath = undefined;
    }
  }
}

/** 单例入口：data/retrieval-index.db（与 agent-sessions.db 同级，随项目目录走） */
export function getRetrieval(dataDir: string): RetrievalIndex {
  return RetrievalIndex.getInstance(join(dataDir, "retrieval-index.db"));
}

/** 检索结果 → 给 LLM 的展示文本 */
export function formatChatHits(hits: ChatHit[]): string {
  if (!hits.length) return "未找到相关消息。可尝试更换/补充关键词（3 个字以上效果更好）。";
  return hits
    .map((h, i) => `${i + 1}. [${fmtTime(h.ts)}] ${h.sender}：${h.snippet}`)
    .join("\n");
}

export function formatFileHits(hits: FileHit[]): string {
  if (!hits.length) return "未找到匹配的文件内容。可尝试更换关键词，或用 list_dir 浏览目录。";
  return hits
    .map((h, i) => `${i + 1}. ${h.agentId} 工作区 ${h.path}：\n${h.snippet}`)
    .join("\n\n");
}
