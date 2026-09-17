// 零依赖 SqliteSaver：基于 Node 22 内置 node:sqlite 实现的 BaseCheckpointSaver。
// 为什么不用官方 @langchain/langgraph-checkpoint-sqlite：它依赖 better-sqlite3（原生模块，
// 安装时需联网下载预编译二进制），违反本项目"完全自包含、零外部依赖"的强校验。
// 逻辑与 schema 照官方实现移植（schema 完全一致，可互为备份恢复），差异仅三点：
//   1) DatabaseSync 替代 better-sqlite3
//   2) 事务用 exec BEGIN/COMMIT/ROLLBACK 替代 db.transaction()
//   3) 预编译语句在 setup 时缓存
import "./suppress-warning.ts"; // 必须先于 node:sqlite 加载（拦截其 ExperimentalWarning 首播）
import { DatabaseSync } from "node:sqlite";
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  maxChannelVersion,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ChannelVersions, Checkpoint, CheckpointListOptions, CheckpointMetadata, CheckpointPendingWrite, CheckpointTuple, PendingWrite } from "@langchain/langgraph-checkpoint";

const TUPLE_SQL = (checkpointId: boolean) => `
  SELECT
    thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata,
    (
      SELECT json_group_array(json_object(
        'task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type, 'value', CAST(pw.value AS TEXT)
      )) FROM writes as pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) as pending_writes,
    (
      SELECT json_group_array(json_object('type', ps.type, 'value', CAST(ps.value AS TEXT)))
      FROM writes as ps
      WHERE ps.thread_id = checkpoints.thread_id
        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
        AND ps.channel = '${TASKS}'
      ORDER BY ps.idx
    ) as pending_sends
  FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ${checkpointId ? "AND checkpoint_id = ?" : "ORDER BY checkpoint_id DESC LIMIT 1"}`;

export class NodeSqliteSaver extends BaseCheckpointSaver {
  private db: DatabaseSync;
  private isSetup = false;
  private withCheckpoint!: ReturnType<DatabaseSync["prepare"]>;
  private withoutCheckpoint!: ReturnType<DatabaseSync["prepare"]>;

  constructor(dbPath: string) {
    super();
    this.db = new DatabaseSync(dbPath);
  }

  /** 单例入口：data/agent-sessions.db（项目内自包含，随项目目录走） */
  private static instance: NodeSqliteSaver | undefined;
  private static instancePath: string | undefined;
  static getInstance(dbPath: string): NodeSqliteSaver {
    if (!NodeSqliteSaver.instance || NodeSqliteSaver.instancePath !== dbPath) {
      NodeSqliteSaver.resetInstance();
      NodeSqliteSaver.instance = new NodeSqliteSaver(dbPath);
      NodeSqliteSaver.instancePath = dbPath;
    }
    return NodeSqliteSaver.instance;
  }
  static resetInstance(): void {
    if (NodeSqliteSaver.instance) {
      try { NodeSqliteSaver.instance.db.close(); } catch { /* 已关闭 */ }
      NodeSqliteSaver.instance = undefined;
      NodeSqliteSaver.instancePath = undefined;
    }
  }

  /** 线程是否已有检查点（同步，供冷启动判断用） */
  hasThread(threadId: string): boolean {
    this.setup();
    return this.db.prepare("SELECT 1 FROM checkpoints WHERE thread_id = ? LIMIT 1").get(threadId) !== undefined;
  }

  /** 读取会话摘要（被挤出上下文窗口的早期内容压缩记忆；无则 null） */
  getSummary(threadId: string): string | null {
    this.setup();
    const row = this.db.prepare("SELECT summary FROM session_summary WHERE thread_id = ?").get(threadId) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  /** 写入/覆盖会话摘要 */
  setSummary(threadId: string, summary: string): void {
    this.setup();
    this.db.prepare("INSERT OR REPLACE INTO session_summary (thread_id, summary, updated_at) VALUES (?, ?, ?)").run(threadId, summary, Date.now());
  }

  /** 同步重置线程（存在则删记录，返回是否存在）——供"会话重置"的同步计数语义 */
  resetThread(threadId: string): boolean {
    this.setup();
    const has = this.hasThread(threadId);
    this.db.prepare("DELETE FROM session_summary WHERE thread_id = ?").run(threadId); // 摘要一并清除
    if (!has) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
      this.db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw e;
    }
    return true;
  }

  /** 修剪线程历史 checkpoint（只保留最近 keep 个）。
   *  LangGraph 每个 superstep 写一个 checkpoint，每行含全量消息 → 长会话 O(n²) 膨胀
   *  （实测 12 轮 = 111 行 / 2.4MB）。本应用不用 time-travel，只读最新状态 → 旧 checkpoint 可安全清除。
   *  删除量大时附带 VACUUM 压实（DELETE 不缩文件；小批量靠 freelist 复用即可，避免每轮全库重写）。
   *  返回删除的 checkpoint 行数。 */
  pruneThread(threadId: string, keep = 3): number {
    this.setup();
    const doomed = this.db.prepare(
      `SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC LIMIT -1 OFFSET ?`
    ).all(threadId, keep) as Array<{ checkpoint_id: string }>;
    if (doomed.length === 0) return 0;
    const delWrites = this.db.prepare(`DELETE FROM writes WHERE thread_id = ? AND checkpoint_id = ?`);
    const delCps = this.db.prepare(`DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id = ?`);
    this.db.exec("BEGIN");
    try {
      for (const { checkpoint_id } of doomed) {
        delWrites.run(threadId, checkpoint_id);
        delCps.run(threadId, checkpoint_id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw e;
    }
    if (doomed.length >= 20) {
      try { this.db.exec("VACUUM"); } catch { /* 压实失败无害：freelist 已可复用 */ }
    }
    return doomed.length;
  }

  private setup(): void {
    if (this.isSetup) return;
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_summary (
  thread_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`);
    this.withoutCheckpoint = this.db.prepare(TUPLE_SQL(false));
    this.withCheckpoint = this.db.prepare(TUPLE_SQL(true));
    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {} as Record<string, string>;
    const args: string[] = [thread_id, checkpoint_ns];
    if (checkpoint_id) args.push(checkpoint_id);
    const row = (checkpoint_id ? this.withCheckpoint : this.withoutCheckpoint).get(...args) as Record<string, never> | undefined;
    if (row === undefined) return undefined;

    let finalConfig = config;
    if (!checkpoint_id) {
      finalConfig = { configurable: { thread_id: row.thread_id as string, checkpoint_ns, checkpoint_id: row.checkpoint_id as string } };
    }
    if (finalConfig.configurable?.thread_id === undefined || finalConfig.configurable?.checkpoint_id === undefined) {
      throw new Error("Missing thread_id or checkpoint_id");
    }
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      JSON.parse(row.pending_writes as unknown as string).map(async (w: { task_id: string; channel: string; type?: string; value?: string }) => [
        w.task_id,
        w.channel,
        await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
      ])
    ) as CheckpointPendingWrite[];
    const checkpoint = (await this.serde.loadsTyped(row.type as unknown as string ?? "json", row.checkpoint as unknown as string)) as Checkpoint;
    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(checkpoint, row.thread_id as unknown as string, row.parent_checkpoint_id as unknown as string);
    }
    return {
      checkpoint,
      config: finalConfig,
      metadata: (await this.serde.loadsTyped(row.type as unknown as string ?? "json", row.metadata as unknown as string)) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id
        ? { configurable: { thread_id: row.thread_id as unknown as string, checkpoint_ns: row.checkpoint_ns as unknown as string, checkpoint_id: row.parent_checkpoint_id as unknown as string } }
        : undefined,
      pendingWrites,
    };
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    this.setup();
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;
    let sql = `
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata,
        (SELECT json_group_array(json_object('task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type, 'value', CAST(pw.value AS TEXT)))
          FROM writes as pw WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns AND pw.checkpoint_id = checkpoints.checkpoint_id) as pending_writes,
        (SELECT json_group_array(json_object('type', ps.type, 'value', CAST(ps.value AS TEXT)))
          FROM writes as ps WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = '${TASKS}' ORDER BY ps.idx) as pending_sends
      FROM checkpoints\n`;
    const whereClause: string[] = [];
    if (thread_id) whereClause.push("thread_id = ?");
    if (checkpoint_ns !== undefined && checkpoint_ns !== null) whereClause.push("checkpoint_ns = ?");
    if (before?.configurable?.checkpoint_id !== undefined) whereClause.push("checkpoint_id < ?");
    const sanitizedFilter = Object.fromEntries(Object.entries(filter ?? {}).filter(([, v]) => v !== undefined));
    whereClause.push(...Object.keys(sanitizedFilter).map(() => "jsonb(CAST(metadata AS TEXT))->? = ?"));
    if (whereClause.length > 0) sql += `WHERE\n  ${whereClause.join(" AND\n  ")}\n`;
    sql += "\nORDER BY checkpoint_id DESC";
    if (limit) sql += ` LIMIT ${parseInt(String(limit), 10)}`;
    const args = [
      thread_id,
      checkpoint_ns,
      before?.configurable?.checkpoint_id,
      ...Object.entries(sanitizedFilter).flatMap(([k, v]) => [`$.${k}`, JSON.stringify(v)]),
    ].filter((v) => v !== undefined && v !== null);
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, never>>;
    for (const row of rows) {
      const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
        JSON.parse(row.pending_writes as unknown as string).map(async (w: { task_id: string; channel: string; type?: string; value?: string }) => [
          w.task_id,
          w.channel,
          await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
        ])
      ) as CheckpointPendingWrite[];
      const checkpoint = (await this.serde.loadsTyped(row.type as unknown as string ?? "json", row.checkpoint as unknown as string)) as Checkpoint;
      if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
        await this.migratePendingSends(checkpoint, row.thread_id as unknown as string, row.parent_checkpoint_id as unknown as string);
      }
      yield {
        config: { configurable: { thread_id: row.thread_id as unknown as string, checkpoint_ns: row.checkpoint_ns as unknown as string, checkpoint_id: row.checkpoint_id as unknown as string } },
        checkpoint,
        metadata: (await this.serde.loadsTyped(row.type as unknown as string ?? "json", row.metadata as unknown as string)) as CheckpointMetadata,
        parentConfig: row.parent_checkpoint_id
          ? { configurable: { thread_id: row.thread_id as unknown as string, checkpoint_ns: row.checkpoint_ns as unknown as string, checkpoint_id: row.parent_checkpoint_id as unknown as string } }
          : undefined,
        pendingWrites,
      };
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions): Promise<RunnableConfig> {
    this.setup();
    void newVersions; // 基类签名对齐（官方实现同样不使用）
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    const thread_id = config.configurable?.thread_id as string;
    const checkpoint_ns = (config.configurable?.checkpoint_ns as string) ?? "";
    const parent_checkpoint_id = config.configurable?.checkpoint_id as string | undefined;
    if (!thread_id) throw new Error('Missing "thread_id" field in passed "config.configurable".');
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type1 !== type2) throw new Error("Failed to serialize checkpoint and metadata to the same type.");
    this.db
      .prepare(`INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(thread_id, checkpoint_ns, checkpoint.id, parent_checkpoint_id ?? null, type1, serializedCheckpoint, serializedMetadata);
    return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    this.setup();
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    if (!config.configurable?.thread_id) throw new Error("Missing thread_id field in config.configurable.");
    if (!config.configurable?.checkpoint_id) throw new Error("Missing checkpoint_id field in config.configurable.");
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const stmt = this.db.prepare(`
      INSERT ${allSpecial ? "OR REPLACE" : "OR IGNORE"} INTO writes
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
        return [
          config.configurable?.thread_id,
          config.configurable?.checkpoint_ns ?? "",
          config.configurable?.checkpoint_id,
          taskId,
          WRITES_IDX_MAP[write[0]] ?? idx,
          write[0],
          type,
          serializedWrite,
        ];
      })
    ) as Array<[string, string, string, string, number, string, string, Uint8Array]>;
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        (stmt.run as (...a: unknown[]) => unknown)(...row);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw e;
    }
  }

  /** 删除整个线程的检查点（重置会话语义） */
  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
      this.db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw e;
    }
  }

  private async migratePendingSends(checkpoint: Checkpoint, threadId: string, parentCheckpointId: string): Promise<void> {
    const row = this.db.prepare(`
          SELECT
            checkpoint_id,
            json_group_array(json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))) as pending_sends
          FROM writes as ps
          WHERE ps.thread_id = ? AND ps.checkpoint_id = ? AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        `).get(threadId, parentCheckpointId) as { pending_sends: string } | undefined;
    if (!row) return;
    const mutable = checkpoint as Checkpoint & { channel_values?: Record<string, unknown> };
    mutable.channel_values ??= {};
    mutable.channel_values[TASKS] = await Promise.all(
      JSON.parse(row.pending_sends).map(({ type, value }: { type: string; value: string }) => this.serde.loadsTyped(type, value))
    );
    const versions = Object.values(checkpoint.channel_versions);
    mutable.channel_versions[TASKS] = versions.length > 0 ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
  }
}
