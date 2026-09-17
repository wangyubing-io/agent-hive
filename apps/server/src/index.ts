import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, extname, basename, resolve, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import { FileStore, newId } from "../../../packages/core/src/store.ts";
import { defaultSettings, DEV_AGENTS } from "../../../packages/core/src/agents.ts";
import { runHarness, shutdownHarness, sessionKey, resetAgentSession, sessionHasHistory, runtimeManager, type AgentResponseFormat } from "../../../packages/core/src/harness.ts";
import { guessContextTokens, DEFAULT_CONTEXT_TOKENS } from "../../../packages/core/src/modelContext.ts";
import { getRetrieval, type RetrievalIndex } from "../../../packages/core/src/retrieval.ts";
import { DEFAULT_SEARCH_PROVIDER } from "../../../packages/core/src/web.ts";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../../../packages/core/src/approval.ts";
import { DISPATCH_RE, parseDispatchBlock, parseReport, type DispatchPlan } from "../../../packages/core/src/plan.ts";
import type { ApprovalRequest } from "../../../packages/core/src/llm.ts";
import { scanDir, diffFiles } from "../../../packages/core/src/files.ts";
import type { GroupFileEntry } from "../../../packages/core/src/files.ts";
import { listActiveStaff, staffDbStatus, type StaffContact } from "./staffDb.ts";
import {
  ensureGitEnv, onGitEnvChange, gitEnvState, gitBin, gitCredOf, saveGitCred, clearGitCred,
  authUrlOf, repoInfo, embeddedCredOf, setupRepoAuth, clearRepoAuth,
} from "./gitEnv.ts";
import type { AgentDef, ChatMsg, Settings, FileAttachment, TraceEntry, WebSearchProvider } from "../../../packages/core/src/types.ts";

// WorkBuddy 沙箱会向 node 进程注入 safe-delete shim：把 fs 删除改造成"送回收站"（单个慢 3s+），
// 且同进程累计删除超阈值（50）直接抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED 崩溃。agent 经 run_shell
// 工具执行的 shell 命令（rm/清理等）会被 shim 拖慢或崩溃。这里在启动早期关闭：本进程内已加载的
// shim 无法再关闭，但所有后续 spawn 的命令子进程会继承该变量，读到 '0' 即跳过，恢复原生删除。
process.env.CODEBUDDY_SAFE_DELETE_ENABLED = "0";

const PORT = Number(process.env.PORT || 18741);
const DATA_DIR = join(process.cwd(), "data");
const UI_DIR = process.env.UI_DIR || join(process.cwd(), "apps", "web");

const store = new FileStore(DATA_DIR);

/** 本地检索索引（FTS5 trigram，零外部依赖）：群聊历史 + 工作区文件内容。
 *  agent 经 search_history / search_workspace 工具检索，可找回上下文窗口之外的更早信息。 */
const retrieval: RetrievalIndex = getRetrieval(DATA_DIR);

/** 启动初始化：对全部群聊历史与工作目录建/补索引（后台执行，不阻塞服务） */
async function initRetrievalInBackground(): Promise<void> {
  const t0 = Date.now();
  try {
    for (const g of loadGroups()) {
      try {
        retrieval.indexChat(g.id, loadHistory(g.id));
        // 文件内容：绑定目录的群索引整个目录一次；未绑定的按成员沙箱各自索引
        if (g.workspace) {
          await retrieval.indexDirAsync(g.id, "shared", g.workspace);
        } else {
          for (const agent of settings.agents) {
            if (agent.id === "human") continue;
            await retrieval.indexDirAsync(g.id, agent.id, join(settings.sandboxDir, agent.id));
          }
        }
      } catch (e) {
        console.warn(`[retrieval] 工作区 ${g.id} 索引失败:`, (e as Error).message);
      }
      await new Promise((r) => setImmediate(r)); // 让出主线程，避免长群阻塞
    }
    const s = retrieval.stats();
    console.log(`[retrieval] 索引就绪（${Date.now() - t0}ms）: 聊天 ${s.chatRows} 条 · 文件分块 ${s.fileRows} 块（${s.files} 个文件）`);
  } catch (e) {
    console.warn("[retrieval] 初始化失败（检索工具将不可用）:", (e as Error).message);
  }
}

/** 进入工作区时推送的历史条数（一页）；更早的走 loadEarlier 按需翻页 */
const HISTORY_PAGE = 50;

// ---------- 设置：磁盘持久化 + 启动时与内置默认深合并 ----------
function mergeAgents(base: AgentDef[], saved?: AgentDef[]): AgentDef[] {
  if (!Array.isArray(saved) || saved.length === 0) return base;
  const merged = base.map((b) => {
    const s = saved.find((x) => x && x.id === b.id);
    return s ? { ...b, ...s, id: b.id, role: b.role } : b; // 内置成员字段可覆盖，id/role 锁定
  });
  // 自定义成员（不在内置列表）原样追加，重启不丢
  const custom = saved.filter((s) => s && s.id && s.shortName && !base.some((b) => b.id === s.id));
  return [...merged, ...(custom as AgentDef[])];
}
/**
 * 读取设置：磁盘存档与内置默认深合并（web.search 两层都要合，存档只改一项时不丢其余）；
 * approval 同样按字段合并（存档只写了 enabled 时 timeoutMs 等回落默认）。
 * --- @ty.aicoding@1789442083508 ---
 */
function loadSettings(): Settings {
  const base = defaultSettings();
  base.sandboxDir = join(DATA_DIR, "sandbox");
  const saved = store.readJson<Partial<Settings> | null>("settings.json", null);
  if (!saved) return base;
  const baseSearch = base.web?.search ?? {};
  const savedSearch = saved.web?.search ?? {};
  return {
    ...base,
    llm: { ...base.llm, ...(saved.llm || {}) }, // 存档缺 protocol 等字段时回落默认值
    autoReply: typeof saved.autoReply === "boolean" ? saved.autoReply : base.autoReply,
    orchestrate: typeof saved.orchestrate === "boolean" ? saved.orchestrate : base.orchestrate,
    agents: mergeAgents(base.agents, saved.agents),
    web: { ...(base.web || {}), ...(saved.web || {}), search: { ...baseSearch, ...savedSearch } },
    approval: { ...(base.approval || {}), ...(saved.approval || {}) },
  };
}
/**
 * 设置落盘：llm（含备用模型）与 web 的 apiKey 都存本机 data 目录（不回传 UI）。
 * --- @ty.aicoding@1789442083508 ---
 */
function saveSettings() {
  // llm 落盘：protocol/model/baseUrl + apiKey（本机 data 目录，不回传 UI）。
  const llm: Record<string, unknown> = {
    protocol: settings.llm.protocol,
    model: settings.llm.model,
    baseUrl: settings.llm.baseUrl,
  };
  if (settings.llm.apiKey) llm.apiKey = settings.llm.apiKey;
  if (settings.llm.contextTokens) llm.contextTokens = settings.llm.contextTokens; // 手动覆盖的上下文窗口；留空=按模型名自动识别
  if (settings.llm.fallback?.model) llm.fallback = settings.llm.fallback; // 备用模型（自带 key，同样只存本机）
  // web 落盘：开关 + 限额 + 搜索后端（search.apiKey 同样只存本机）
  const search: Record<string, unknown> = { provider: settings.web?.search?.provider || DEFAULT_SEARCH_PROVIDER };
  if (settings.web?.search?.baseUrl) search.baseUrl = settings.web.search.baseUrl;
  if (settings.web?.search?.apiKey) search.apiKey = settings.web.search.apiKey;
  if (settings.web?.search?.count) search.count = settings.web.search.count;
  const web: Record<string, unknown> = {
    enabled: settings.web?.enabled !== false,
    allowPrivateHosts: settings.web?.allowPrivateHosts !== false,
    search,
  };
  if (settings.web?.fetchTimeoutMs) web.fetchTimeoutMs = settings.web.fetchTimeoutMs;
  if (settings.web?.fetchMaxChars) web.fetchMaxChars = settings.web.fetchMaxChars;
  // approval 落盘：开关 + 附加危险模式 + 等待超时
  const approval: Record<string, unknown> = { enabled: settings.approval?.enabled !== false };
  if (settings.approval?.extraPatterns?.length) approval.extraPatterns = settings.approval.extraPatterns;
  if (settings.approval?.timeoutMs) approval.timeoutMs = settings.approval.timeoutMs;
  store.writeJson("settings.json", {
    llm,
    web,
    approval,
    autoReply: settings.autoReply,
    orchestrate: settings.orchestrate,
    agents: settings.agents,
  }); // sandboxDir 等派生字段不落盘
}
const settings: Settings = loadSettings();

/** 当前生效的 API Token（settings > apiKeyEnv 指定变量 > 协议默认变量） */
function llmKeyNow(): string {
  return settings.llm.apiKey ||
    (settings.llm.apiKeyEnv ? process.env[settings.llm.apiKeyEnv] || "" : "") ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    "";
}

/**
 * 当前生效的搜索 key：设置里填的 > 对应环境变量（bocha/tavily 才需要）。
 * --- @ty.aicoding@1789436639812 ---
 */
function webSearchKeyNow(): string {
  const p = settings.web?.search?.provider || DEFAULT_SEARCH_PROVIDER;
  const envName = p === "bocha" ? "BOCHA_API_KEY" : p === "tavily" ? "TAVILY_API_KEY" : "";
  return (settings.web?.search?.apiKey || "").trim() || (envName ? process.env[envName] || "" : "");
}

/**
 * 推给 UI 的设置视图（不含 key 等敏感字段；apiKey 只给 hasKey 布尔）。
 * --- @ty.aicoding@1789442083508 ---
 */
function publicSettings() {
  const llm = settings.llm;
  const fb = llm.fallback;
  return {
    autoReply: settings.autoReply,
    orchestrate: settings.orchestrate !== false,
    model: llm.model,
    protocol: llm.protocol || "openai",
    baseUrl: llm.baseUrl || "",
    hasKey: !!llmKeyNow(),
    // 上下文窗口：contextManual=手动覆盖值（未设置为 null）；contextEffective=实际生效值（手动 > 按模型名识别 > 默认 256k）
    contextManual: llm.contextTokens ?? null,
    contextEffective: llm.contextTokens ?? guessContextTokens(llm.model) ?? DEFAULT_CONTEXT_TOKENS,
    contextAuto: llm.contextTokens == null,
    // 备用模型（主模型连接失败时降级）：model 为空=未配置；apiKey 同样只回传布尔
    fallbackModel: fb?.model || "",
    fallbackProtocol: fb?.protocol || "",
    fallbackBaseUrl: fb?.baseUrl || "",
    fallbackHasKey: !!(fb?.apiKey || fb?.apiKeyEnv),
    // 危险命令审批闸门（run_shell 的 interrupt）
    approval: {
      enabled: settings.approval?.enabled !== false,
      timeoutMs: settings.approval?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
      extraPatterns: (settings.approval?.extraPatterns || []).join("\n"),
    },
    // 联网（web_fetch / web_search）：key 同样只回传布尔
    web: {
      enabled: settings.web?.enabled !== false,
      allowPrivateHosts: settings.web?.allowPrivateHosts !== false,
      fetchTimeoutMs: settings.web?.fetchTimeoutMs ?? null,
      fetchMaxChars: settings.web?.fetchMaxChars ?? null,
      searchProvider: settings.web?.search?.provider || DEFAULT_SEARCH_PROVIDER,
      searchBaseUrl: settings.web?.search?.baseUrl || "",
      searchCount: settings.web?.search?.count ?? null,
      searchHasKey: !!webSearchKeyNow(),
      searchKeyFromEnv: !settings.web?.search?.apiKey && !!webSearchKeyNow(),
    },
  };
}

/** 内置成员 id（不可删除，防止误删后编排/默认工作区失能） */
const BUILTIN_IDS = new Set(DEV_AGENTS.map((a) => a.id));
/** 推给 UI 的成员列表（附 builtin 标记，UI 决定能否删除） */
function publicAgents() {
  // llm 只回模型/协议/地址给 UI（角色级 apiKey 不下发）
  return settings.agents.map((a) => ({
    ...a,
    llm: a.llm ? { model: a.llm.model, protocol: a.llm.protocol, baseUrl: a.llm.baseUrl } : undefined,
    builtin: BUILTIN_IDS.has(a.id),
  }));
}

// ---------- 真人通讯录：全量在职员工（uc_staff）缓存 + 域账号登录 ----------
// 真人成员 id 规范：h_<纯域账号>（与 human / ai-* 区分），由 staffDb rowToContact 生成
// 员工缓存：首次连接/登录时从库拉全量，成功后广播；失败保留 error 供状态提示，30s 冷却重试
let staffCache: StaffContact[] = [];
let staffState: "idle" | "ready" | "error" = "idle";
let staffError: string | null = null;
let staffLoadedAt = 0;
let staffPromise: Promise<void> | null = null;
const STAFF_RETRY_GAP_MS = 30_000;
function refreshStaff(): Promise<void> {
  if (staffPromise) return staffPromise;
  staffPromise = (async () => {
    console.log("[staff] 开始从 uc_staff 拉取在职员工…");
    try {
      const r = await listActiveStaff();
      console.log(`[staff] 拉取结束 ok=${r.ok} count=${r.staff?.length ?? 0} ${r.error ? "err=" + r.error : ""}`);
      if (r.ok && r.staff) {
        staffCache = r.staff;
        staffState = "ready";
        staffError = null;
        staffLoadedAt = Date.now();
      } else {
        staffState = "error";
        staffError = r.error || "员工列表加载失败";
        console.error(`[staff] 员工列表加载失败: ${staffError}`);
      }
    } catch (e) {
      staffState = "error";
      staffError = (e as Error).message;
      console.error(`[staff] 员工列表异常: ${staffError}`);
    } finally {
      staffPromise = null;
    }
    // 加载完成（成功或失败）都通知所有端刷新通讯录；groups 重推以恢复员工成员的显示
    io.emit("staff", publicStaff());
    pushGroupsAll();
  })();
  return staffPromise;
}
function publicStaff(): StaffContact[] {
  return staffCache;
}
function staffByAccount(account: string): StaffContact | undefined {
  return staffCache.find((s) => s.domainAccount === account);
}
function staffById(id: string): StaffContact | undefined {
  return staffCache.find((s) => s.id === id);
}
/** 可进入工作区的合法成员 id：AI 成员 + human（真人开放位）+ 全部在职员工 */
function memberValidIds(): Set<string> {
  return new Set([...settings.agents.map((a) => a.id), "human", ...staffCache.map((s) => s.id)]);
}
/** 域账号规整：company\zhangsan / zhangsan@corp / ZhansSan → zhangsan */
function normalizeDomainAccount(raw: string): string {
  let acc = (raw || "").trim().toLowerCase();
  if (acc.includes("\\")) acc = acc.split("\\").pop() || "";
  if (acc.includes("@")) acc = acc.split("@")[0];
  return acc.trim();
}

interface LoginUser {
  id: string; // h_<域账号>（工作区成员 id）
  name: string;
  account: string; // 纯域账号（小写）
  title?: string;
}
function loginUserOf(s: StaffContact): LoginUser {
  return { id: s.id, name: s.name, account: s.domainAccount, title: s.title };
}
/**
 * 域账号登录校验：优先匹配内存员工缓存；缓存未就绪/超过 60s 先刷新一次全量。
 * 命中 → 返回登录身份（缓存无该账号=不在职/离职/域账号错）。
 * --- @ty.aicoding@1789634086948 ---
 */
async function resolveLogin(raw: string): Promise<{ ok: boolean; user?: LoginUser; error?: string }> {
  const account = normalizeDomainAccount(raw);
  if (!account) return { ok: false, error: "请输入域账号" };
  if (staffState !== "ready" || Date.now() - staffLoadedAt > 60_000) await refreshStaff();
  const s = staffByAccount(account);
  if (!s) {
    if (staffState === "error") return { ok: false, error: `员工库未就绪，无法校验域账号（${staffError || "加载失败"}）` };
    return { ok: false, error: `未找到在职员工「${account}」：请确认域账号拼写（纯用户名，如 zhangsan1）` };
  }
  return { ok: true, user: loginUserOf(s) };
}

/** 任务 prompt 里的真人称呼：有登录人用实名，无（定时任务等）用系统触发 */
function senderLabel(sender?: LoginUser | null): string {
  return sender
    ? `真人「${sender.name}」${sender.account ? `（域账号 ${sender.account}）` : ""}在工作区里发言`
    : "系统触发（定时任务/自动任务）在工作区里触发需求";
}

// ---------- 工作区 & 历史 ----------
interface GroupLite {
  id: string;
  name: string;
  desc: string;
  memberIds: string[]; // 工作区成员（agent id + "human"），旧数据缺省归一化为全员
  workspace?: string; // 工作区绑定目录（绝对路径）：配置后 agent 在此干活（全员共享、产物 diff 此目录）；空 = 各自沙箱
  gitUrl?: string; // Git 仓库 http(s) 克隆地址（脱敏后，不含内嵌账号密码）：克隆后绑定为 workspace
  createdAt: number;
}

/** Git 克隆到本机受管目录（data/git/<groupId>），与群工作区绑定 */
function gitRepoRoot(): string {
  return join(DATA_DIR, "git");
}
function gitRepoDir(groupId: string): string {
  return join(gitRepoRoot(), groupId);
}
/** 仓库级推送凭据文件（放 git 根下的 .creds/，避开 agent 工作区 —— read_file 越界读不到 token） */
function gitCredFile(groupId: string): string {
  return join(gitRepoRoot(), ".creds", groupId);
}
/** 去掉 URL 中内嵌的 user:pass@，避免把凭据落盘到 groups.json / .git/config */
function sanitizeGitUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    /* 保持原样 */
  }
  return url;
}
function runGit(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
    }, opts.timeoutMs || 300000);
    const proc = spawn(gitBin(), args, { cwd: opts.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr.on("data", (d) => (err += d.toString("utf8")));
    proc.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: String(e.message || e) });
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out, err });
    });
  });
}
/** git 报错取可读的最后几行（stderr 常为多行堆栈） */
function gitErr(r: { out: string; err: string }): string {
  const lines = (r.err || r.out || "").trim().split(/\r?\n/).filter(Boolean);
  return (lines.slice(-3).join(" ") || "未知错误").slice(0, 400);
}
/** 进行中的工作区 Git 任务（防同工作区重复 clone/pull） */
const gitJobs = new Map<string, Promise<unknown>>();

function loadGroups(): GroupLite[] {
  const raw = store.readJson<Array<{ id?: string; name?: string; desc?: string; memberIds?: string[]; workspace?: string; gitUrl?: string; createdAt?: number }>>("groups.json", []);
  const validIds = memberValidIds();
  const groups: GroupLite[] = raw
    .filter((g) => g && g.id)
    .map((g) => ({
      id: g.id!,
      name: g.name || "未命名工作区",
      desc: g.desc || "",
      memberIds: Array.isArray(g.memberIds) && g.memberIds.length > 0
        ? g.memberIds.filter((m) => validIds.has(m))
        : ["human", ...settings.agents.map((a) => a.id)],
      workspace: typeof g.workspace === "string" && g.workspace.trim() ? g.workspace.trim() : undefined,
      gitUrl: typeof g.gitUrl === "string" && g.gitUrl.trim() ? g.gitUrl.trim() : undefined,
      createdAt: g.createdAt || 0,
    }));
  if (!groups.find((g) => g.id === "g-dev")) {
    groups.unshift({
      id: "g-dev", name: "🧑‍💻AI研发部", desc: "把需求丢进来，全员协作完成",
      memberIds: ["human", ...settings.agents.map((a) => a.id)], createdAt: Date.now(),
    });
    store.writeJson("groups.json", groups);
  }
  return groups;
}
function saveGroups(groups: GroupLite[]) {
  store.writeJson("groups.json", groups);
}
function findGroup(groupId: string): GroupLite | undefined {
  return loadGroups().find((g) => g.id === groupId);
}
/** agent 的实际工作目录：工作区绑定了共享目录 → 全员在该目录干活（真实项目协作）；否则各自沙箱 */
function groupWorkspace(groupId: string, agent: AgentDef): string {
  const g = findGroup(groupId);
  if (g?.workspace) return g.workspace;
  return join(settings.sandboxDir, agent.id);
}
/** 工作区列表摘要：附带各工作区最后一条消息（侧边栏预览用） */
function groupSummaries(): Array<GroupLite & { lastText: string; lastTs: number }> {
  return loadGroups().map((g) => {
    const last = store.readLinesTail<ChatMsg>(`messages/${g.id}.jsonl`, 1)[0];
    return {
      ...g,
      lastText: last ? `${last.senderName}: ${last.text}`.replace(/\n/g, " ").slice(0, 60) : "",
      lastTs: last?.ts || 0,
    };
  });
}
function loadHistory(groupId: string): ChatMsg[] {
  return store.readLines<ChatMsg>(`messages/${groupId}.jsonl`);
}
/** 取最近一页历史（尾部读，避免进入工作区时全量读文件）；返回消息与是否有更早消息 */
function loadHistoryPage(groupId: string, limit: number): { messages: ChatMsg[]; hasMore: boolean } {
  const tail = store.readLinesTail<ChatMsg>(`messages/${groupId}.jsonl`, limit + 1);
  const hasMore = tail.length > limit;
  return { messages: hasMore ? tail.slice(1) : tail, hasMore };
}
function appendMsg(groupId: string, msg: ChatMsg) {
  store.appendLine(`messages/${groupId}.jsonl`, msg);
  try { retrieval.indexChat(groupId, [msg]); } catch { /* 索引失败不影响消息本身 */ }
}

// ---------- 工作区文件区 ----------
function loadGroupFiles(groupId: string): GroupFileEntry[] {
  return store.readJson<GroupFileEntry[]>(`files/${groupId}.json`, []);
}
function saveGroupFiles(groupId: string, files: GroupFileEntry[]) {
  store.writeJson(`files/${groupId}.json`, files.slice(-200)); // 环形上限，防无限膨胀
}
/** 按 id 在所有工作区里找文件条目（下载入口用，文件可能来自任意工作区） */
function findFileEntry(fileId: string): GroupFileEntry | undefined {
  for (const g of loadGroups()) {
    const e = loadGroupFiles(g.id).find((f) => f.id === fileId);
    if (e) return e;
  }
  return undefined;
}
function fileAbsPath(entry: GroupFileEntry): string | null {
  // 防路径穿越：解析后必须仍在收集根内（工作区绑定目录或该 agent 的沙箱目录）
  const root = entry.baseDir || join(settings.sandboxDir, entry.agentId);
  const abs = join(root, entry.path);
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (!norm(abs).startsWith(norm(root) + "/") && norm(abs) !== norm(root)) return null;
  return abs;
}
/** run 结束后收集工作区里新增/变化的文件，广播进工作区文件区
 *  归属判定：显式写文件的工具调用（事件流 claimed 集合）→ 确定归属本人；
 *  多 agent 并行时未 claimed 的产出（如 bash 重定向）→ 诚实标记「团队产出」防误署名 */
const TEAM_OWNER = { id: "team", name: "团队产出", shortName: "🤝 团队" };
function collectSandboxFiles(
  groupId: string,
  agent: AgentDef,
  cwd: string,
  before: Map<string, { path: string; mtimeMs: number; size: number }>,
  opts: { claimed?: Set<string>; concurrentCount?: number } = {}
) {
  const after = scanDir(cwd);
  const changed = diffFiles(before, after);
  if (changed.length === 0) return;
  const multi = (opts.concurrentCount || 1) > 1;
  const files = loadGroupFiles(groupId);
  for (const f of changed) {
    const claimed = !multi || !opts.claimed || opts.claimed.size === 0 || opts.claimed.has(f.path);
    const owner = claimed ? agent : { ...agent, id: TEAM_OWNER.id, name: TEAM_OWNER.name, shortName: TEAM_OWNER.shortName };
    // 去重：并行时同一文件可能被多个 agent 的 diff 各收一次（如"团队"+"本人"）。
    // 60s 内同路径已有条目 → 有署名的新条目替换旧的（团队→本人），否则跳过。
    const dupIdx = files.findIndex(
      (x) => x.path === f.path && x.baseDir === cwd && Date.now() - x.ts < 60_000
    );
    if (dupIdx >= 0) {
      const dup = files[dupIdx];
      const newHasOwner = owner.id !== TEAM_OWNER.id;
      if (newHasOwner && dup.agentId === TEAM_OWNER.id) {
        const entry: GroupFileEntry = {
          id: dup.id, // 沿用旧 id：已广播的引用不失效
          groupId, agentId: owner.id, agentName: owner.name, agentShortName: owner.shortName,
          path: f.path, baseDir: cwd, name: basename(f.path), size: f.size, ts: Date.now(),
        };
        files[dupIdx] = entry;
        io.to(groupId).emit("file", entry);
      }
      continue;
    }
    const entry: GroupFileEntry = {
      id: newId("f"),
      groupId,
      agentId: owner.id,
      agentName: owner.name,
      agentShortName: owner.shortName,
      path: f.path,
      baseDir: cwd,
      name: basename(f.path),
      size: f.size,
      ts: Date.now(),
    };
    files.push(entry);
    io.to(groupId).emit("file", entry);
  }
  saveGroupFiles(groupId, files);
}

// ---------- 路由: 真人消息 -> 该让谁干活（数据驱动，支持自定义成员；只认工作区内成员） ----------
// 规则（可预期、不误触发）：
//   ① 显式 @ 提及优先：@短名/@全名/@角色别名（前端/后端/测试/主AI…）—— 一条消息 @ 多人 → 并行执行
//   ② 裸短名（专属昵称）也算点名
//   ③ 通用角色词必须带 @ 才算点名，避免「跑个测试」误触发测试工程师
//   ④ 显式 @ 真人（@姓名/@域账号）= 点名真人：真人之间对话，任何 AI（含主 AI）都不接管
//   ⑤ 谁都没点名 → 工作区内 lead 接管（编排模式）
const ROLE_ALIAS: Record<string, string[]> = {
  fe: ["前端"], be: ["后端"], qa: ["测试"], ops: ["运维"], design: ["设计"],
  lead: ["主ai", "经理", "lead"],
};
/** 工作区内成员池（路由、编排、分派都只认工作区内成员） */
function memberAgents(groupId: string): AgentDef[] {
  const g = findGroup(groupId);
  if (!g) return [];
  const ids = new Set(g.memberIds);
  return settings.agents.filter((a) => ids.has(a.id));
}
/** 消息是否显式 @ 了工作区内的真人成员（@姓名/@域账号）——点名真人 = 真人之间对话，主 AI 不接管 */
function mentionsHumanMember(groupId: string, text: string): boolean {
  const g = findGroup(groupId);
  if (!g) return false;
  const lo = text.toLowerCase();
  const hit = (s: StaffContact) =>
    (!!s.name && lo.includes("@" + s.name.toLowerCase())) ||
    (!!s.domainAccount && lo.includes("@" + s.domainAccount.toLowerCase()));
  // 私有工作区：只认被勾进工作区的真人成员
  for (const m of g.memberIds) {
    if (!m.startsWith("h_")) continue;
    const s = staffById(m);
    if (s && hit(s)) return true;
  }
  // 全员工作区（human 开放位）：任何在职员工都可被 @
  if (g.memberIds.includes("human")) return staffCache.some(hit);
  return false;
}
function routeTasks(groupId: string, text: string): AgentDef[] {
  const pool = memberAgents(groupId);
  if (pool.length === 0) return [];
  const lo = text.toLowerCase();
  const explicit = pool.filter((a) =>
    lo.includes("@" + a.shortName.toLowerCase()) ||
    lo.includes("@" + a.name.toLowerCase()) ||
    (ROLE_ALIAS[a.role] || []).some((w) => lo.includes("@" + w))
  );
  if (explicit.length > 0) return explicit;
  const bare = pool.filter((a) => lo.includes(a.shortName.toLowerCase()));
  if (bare.length > 0) return bare;
  // 显式 @ 了真人 = 点名真人：真人之间对话，任何 AI（含主 AI）都不接管
  if (mentionsHumanMember(groupId, text)) return [];
  // 谁都没 @: 默认工作区内项目总监接管（需求入口）
  if (settings.autoReply) {
    const lead = pool.find((a) => a.role === "lead");
    if (lead && !/^\s*(你好|hi|hello|在吗|谢谢|好的|ok|收到)/i.test(text.trim())) return [lead];
  }
  return [];
}

// ---------- Socket.IO ----------
const httpServer = createServer((req, res) => {
  // 静态托管聊天 UI
  let path = decodeURIComponent((req.url || "/").split("?")[0]);
  if (path === "/") path = "/index.html";
  if (path === "/socket.io/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("socket.io");
    return;
  }
  // 本地托管 socket.io 客户端（CDN 在本网络可能不通）
  if (path === "/vendor/socket.io.js") {
    const clientFile = join(process.cwd(), "node_modules", "socket.io", "client-dist", "socket.io.min.js");
    if (existsSync(clientFile)) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(clientFile));
      return;
    }
  }
  // 真人上传附件：POST /api/upload（JSON base64，避免 multipart 解析；上限 10MB）
  if (path === "/api/upload" && (req.method === "POST" || req.method === "PUT")) {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const bad = (error: string) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error }));
      };
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const groupId = String(body.groupId || "");
        if (!findGroup(groupId)) { bad("工作区不存在"); return; }
        const name = String(body.name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "file";
        const size = Number(body.size || 0);
        const dataB64 = typeof body.data === "string" ? body.data.split(",").pop() || "" : "";
        if (!dataB64 || size <= 0 || size > 10 * 1024 * 1024) { bad("文件为空或超过 10MB 上限"); return; }
        const data = Buffer.from(dataB64, "base64");
        const id = newId("up");
        const dir = join(DATA_DIR, "uploads", groupId);
        mkdirSync(dir, { recursive: true });
        const fname = `${id}_${name}`;
        writeFileSync(join(dir, fname), data);
        const url = `/api/uploads/${groupId}/${encodeURIComponent(fname)}`;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, file: { id, name, size, mime: String(body.mime || "application/octet-stream"), url } }));
      } catch (e) {
        bad(String((e as Error)?.message || e));
      }
    });
    return;
  }
  // 附件下载/展示：GET /api/uploads/<groupId>/<fileId>_<name>（图片 inline 内联展示，其余 attachment 下载）
  const upMatch = path.match(/^\/api\/uploads\/([^/]+)\/(.+)$/);
  if (upMatch) {
    const gid = upMatch[1];
    const rel = upMatch[2];
    const base = join(DATA_DIR, "uploads", gid);
    const abs = join(base, rel);
    const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
    if (!norm(abs).startsWith(norm(base) + "/") || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("upload not found");
      return;
    }
    const ext = extname(rel).toLowerCase();
    const isImg = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext);
    const MIME: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
      ".webp": "image/webp", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
      ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf", ".zip": "application/zip",
    };
    const dispName = rel.includes("_") ? rel.slice(rel.indexOf("_") + 1) : rel;
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-disposition": isImg ? "inline" : `attachment; filename*=UTF-8''${encodeURIComponent(dispName)}`,
      "cache-control": "public, max-age=3600",
    });
    res.end(readFileSync(abs));
    return;
  }
  // 工作区文件下载：/api/files/<fileId>/download（文件可能来自任意工作区，跨工作区搜索）
  const dlMatch = path.match(/^\/api\/files\/([^/]+)\/download$/);
  if (dlMatch) {
    const entry = findFileEntry(dlMatch[1]);
    const abs = entry && fileAbsPath(entry);
    if (!entry || !abs || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("file not found");
      return;
    }
    const types: Record<string, string> = {
      ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
      ".json": "application/json; charset=utf-8", ".js": "text/javascript; charset=utf-8",
      ".ts": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8",
      ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
      ".pdf": "application/pdf", ".zip": "application/zip",
    };
    const fname = encodeURIComponent(entry.name);
    res.writeHead(200, {
      "content-type": types[extname(abs).toLowerCase()] || "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${fname}`,
    });
    res.end(readFileSync(abs));
    return;
  }
  // 工作区文件文本预览：/api/files/<fileId>/preview（类型白名单 + 大小上限，返回 JSON）
  const pvMatch = path.match(/^\/api\/files\/([^/]+)\/preview$/);
  if (pvMatch) {
    const entry = findFileEntry(pvMatch[1]);
    const abs = entry && fileAbsPath(entry);
    const PREVIEW_EXT = new Set([".txt", ".md", ".json", ".js", ".ts", ".mjs", ".css", ".html", ".csv", ".log", ".yml", ".yaml", ".py", ".sh"]);
    const bad = (reason: string) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: reason }));
    };
    if (!entry || !abs || !existsSync(abs) || !statSync(abs).isFile()) { bad("not found"); return; }
    if (!PREVIEW_EXT.has(extname(abs).toLowerCase())) { bad("unsupported type"); return; }
    if (statSync(abs).size > 200_000) { bad("file too large (>200KB)"); return; }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, name: entry.name, text: readFileSync(abs, "utf8") }));
    return;
  }
  // 聊天记录导出：/api/groups/<groupId>/export.md
  const exMatch = path.match(/^\/api\/groups\/([^/]+)\/export\.md$/);
  if (exMatch) {
    const gid = exMatch[1];
    const g = loadGroups().find((x) => x.id === gid);
    const hist = loadHistory(gid);
    const p2 = (x: number) => String(x).padStart(2, "0");
    const fmt = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
    const lines: string[] = [
      `# ${g ? g.name : "工作区"} · 聊天记录`,
      "",
      `> 导出时间：${fmt(Date.now())} · 共 ${hist.length} 条消息`,
      "",
      "---",
      "",
    ];
    for (const m of hist) {
      lines.push(`**[${fmt(m.ts)}] ${m.senderName}**`, "", m.text, "", "---", "");
    }
    const fname = encodeURIComponent(`${g ? g.name : "chat"}-聊天记录.md`);
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${fname}`,
    });
    res.end(lines.join("\n"));
    return;
  }
  const file = join(UI_DIR, path);
  if (!file.startsWith(UI_DIR) || !existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".json": "application/json",
  };
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});

const io = new Server(httpServer, { cors: { origin: "*" } });
// git 环境状态变化 → 广播给所有端（工具条/克隆按钮据此禁用或提示安装中）
onGitEnvChange((s) => {
  io.emit("gitEnv", s);
  if (s.status === "ready") console.log(`[git] 环境就绪 git ${s.version}`);
  else if (s.status === "missing") console.warn(`[git] 环境不可用: ${s.detail || "git 未安装"}`);
});

// ---------- 多人部署身份：会话令牌 + 同账号单活 + 按工作区成员隔离可见性 ----------
// 登录 → 服务端签发 token（不信任前端自报身份）；此后每个 socket 用 auth.token 恢复身份，
// 发消息/进入工作区均由服务端从 token 还原"登录人"。同一域账号同时只允许一个在线会话：
// 新登录会作废旧 token 并踢掉旧连接 —— 杜绝"多人共用同一账号"。
// 工作区可见性：全员工作区(memberIds 含 human)对所有登录真人可见；否则仅 h_<域账号> 成员可见。
interface AuthSession {
  token: string;
  user: LoginUser;
  createdAt: number;
  socketId: string | null;
}
const sessions = new Map<string, AuthSession>(); // token → 会话
const sessionByAccount = new Map<string, string>(); // 域账号 → 当前有效 token（单活索引）
const SESSION_TTL_MS = 7 * 24 * 3600_000; // 7 天免登录
function randomToken(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}
function persistSessions() {
  store.writeJson("sessions.json", [...sessions.values()].map(({ token, user, createdAt }) => ({ token, user, createdAt })));
}
function loadSessions() {
  sessions.clear();
  sessionByAccount.clear();
  const saved = store.readJson<Array<{ token?: string; user?: LoginUser; createdAt?: number }>>("sessions.json", []);
  const now = Date.now();
  for (const s of saved) {
    if (!s || typeof s.token !== "string" || !s.token || !s.user || !s.user.account) continue;
    if (now - (s.createdAt || 0) > SESSION_TTL_MS) continue;
    sessions.set(s.token, { token: s.token, user: s.user, createdAt: s.createdAt || now, socketId: null });
    sessionByAccount.set(s.user.account, s.token);
  }
}
function revokeSession(token: string) {
  const s = sessions.get(token);
  if (!s) return;
  sessions.delete(token);
  if (sessionByAccount.get(s.user.account) === token) sessionByAccount.delete(s.user.account);
  persistSessions(); // 作废即落盘：防服务重启后 sessions.json 把已登出/过期/被顶会话复活
}
/** 为真人签发新会话；该账号已有会话（含在线端）→ 作废旧 token 并踢掉旧连接（单活） */
function issueSession(user: LoginUser): string {
  const oldToken = sessionByAccount.get(user.account);
  if (oldToken) {
    const old = sessions.get(oldToken);
    if (old?.socketId) {
      const so = io.sockets.sockets.get(old.socketId);
      if (so && so.connected) {
        so.data.user = null;
        so.data.token = "";
        try {
          so.emit("kicked", { reason: "该账号已在其他位置登录，本会话已下线" });
          so.disconnect(true);
        } catch {
          /* 断线竞态可忽略 */
        }
      }
    }
    revokeSession(oldToken);
  }
  const token = randomToken();
  sessions.set(token, { token, user, createdAt: Date.now(), socketId: null });
  sessionByAccount.set(user.account, token);
  persistSessions();
  return token;
}
/** 真人是否在工作区 G 内（可见/可发言）：全员工作区(human 开放位) 或 memberIds 含 h_<域账号> */
function groupAllowedFor(g: GroupLite, user: LoginUser | null | undefined): boolean {
  if (!user) return false;
  return g.memberIds.includes("human") || g.memberIds.includes(user.id);
}
function groupsForUser(user: LoginUser | null | undefined): Array<GroupLite & { lastText: string; lastTs: number }> {
  return groupSummaries().filter((g) => groupAllowedFor(g, user));
}
/** 登录态/工作区成员变化后，让 socket 加入或离开有权/无权的工作区房间 */
function syncRooms(socket: Socket) {
  const user = (socket.data.user as LoginUser | null | undefined) || null;
  for (const g of loadGroups()) {
    if (groupAllowedFor(g, user)) {
      if (!socket.rooms.has(g.id)) socket.join(g.id);
    } else if (socket.rooms.has(g.id)) {
      socket.leave(g.id);
    }
  }
}
/** 按当前登录人把可见工作区列表推给单个 socket（当前查看的工作区已无权时复位） */
function pushGroupsTo(socket: Socket) {
  const user = (socket.data.user as LoginUser | null | undefined) || null;
  const list = groupsForUser(user);
  socket.emit("groups", list);
  if (socket.data.groupId && !list.some((g) => g.id === socket.data.groupId)) {
    socket.data.groupId = null;
  }
}
/** 所有在线 socket 按各自身份刷新房间与工作区列表（工作区/成员变更后的统一广播） */
function pushGroupsAll() {
  for (const s of io.sockets.sockets.values()) {
    if (!s.connected) continue;
    syncRooms(s);
    pushGroupsTo(s);
  }
}
/** 握手凭据 → 恢复登录人（token 无效/过期返回 false，客户端将回到门禁） */
function bindAuth(socket: Socket): boolean {
  const token = String(socket.handshake.auth?.token || socket.handshake.query?.token || "");
  if (!token) return false;
  const sess = sessions.get(token);
  if (!sess) return false;
  if (Date.now() - sess.createdAt > SESSION_TTL_MS) {
    revokeSession(token);
    return false;
  }
  sess.socketId = socket.id;
  socket.data.user = sess.user;
  socket.data.token = token;
  return true;
}
loadSessions();
loadGroups(); // 确保默认工作区存在

/** agent 回复落到工作区（消息存储 + 广播），trace 为思考过程（推理步骤 + 工具调用 + 结果） */
function postAgentReply(groupId: string, agent: AgentDef, text: string, trace?: TraceEntry[]) {
  const reply: ChatMsg = {
    id: newId("m"),
    groupId,
    senderId: agent.id,
    senderName: agent.name,
    kind: "text",
    text,
    trace: trace && trace.length ? trace : undefined,
    ts: Date.now(),
  };
  appendMsg(groupId, reply);
  io.to(groupId).emit("message", reply);
}

/** 工具调用 → 中文标签（思考过程展示用） */
const TOOL_LABEL: Record<string, string> = {
  bash: "执行命令", shell: "执行命令", write: "写入文件", write_file: "写入文件",
  read: "读取文件", read_file: "读取文件", edit: "编辑文件", glob: "查找文件",
  grep: "搜索内容", web_search: "联网搜索", web_fetch: "读取网页", todo: "更新任务清单",
  remember: "记入长期记忆", recall: "查询长期记忆",
};

// 会话种子：每个 (agent,cwd) 首次执行时注入最近工作区摘要（会话重置/新成员冷启动时立刻有上下文）；
// 后续轮不注入（会话自带记忆，重复注入浪费 token 且可能干扰）
const sessionSeeded = new Set<string>();
function seedContext(groupId: string, agent: AgentDef, cwd: string): string {
  const key = `${agent.id}\u0000${cwd}`;
  if (sessionSeeded.has(key)) return "";
  sessionSeeded.add(key);
  // 已有持久化会话记忆（agent-sessions.db）→ 不注入种子，避免与真实历史重复/冲突
  // （会话记忆跨 server 重启存活，此检查保证重启后不会二次注入）
  if (sessionHasHistory(agent.id, cwd, settings.sandboxDir)) return "";
  const hist = loadHistory(groupId).slice(-15);
  if (hist.length === 0) return "";
  const lines = hist
    .map((m) => `${m.senderName}: ${m.text.replace(/\s+/g, " ").slice(0, 120)}`)
    .join("\n");
  return `\n\n--- 工作区近期记录（帮你了解上下文，无需重复处理）---\n${lines}`;
}

/** 把 agent 事件里的任意 content（字符串 / 内容分片数组 / 对象）安全抽成可读文本，杜绝 [object Object] */
function contentToText(v: unknown, max = 400): string {
  if (v == null) return "";
  const walk = (x: unknown): string => {
    if (typeof x === "string") return x;
    if (typeof x === "number" || typeof x === "boolean") return String(x);
    if (Array.isArray(x)) return x.map(walk).filter(Boolean).join("\n");
    if (typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (typeof o.text === "string" && o.text) return o.text;
      if (o.content != null) return walk(o.content);
      if (o.message != null) return walk(o.message);
      if (o.output != null) return walk(o.output);
      if (o.result != null) return walk(o.result);
      const j = JSON.stringify(o);
      return j && j !== "{}" ? j : "";
    }
    return String(x);
  };
  const s = walk(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 单个 agent 处理一条工作区消息：typing → 事件流 → 回复 → 产物收集 → done。返回回复文本 */
// ---------- 手动停止：工作区成员可终止进行中/排队中的 agent 执行 ----------
interface ActiveRun { agentId: string; ctl: AbortController }
const ORCH_AGENT_KEY = "__orch__"; // 编排整体控制器：停止时连带未启动的后续波次
const activeRuns = new Map<string, Set<ActiveRun>>(); // groupId → 本轮活动执行
function registerRun(groupId: string, agentId: string, ctl: AbortController): ActiveRun {
  let s = activeRuns.get(groupId);
  if (!s) { s = new Set(); activeRuns.set(groupId, s); }
  const r: ActiveRun = { agentId, ctl };
  s.add(r);
  return r;
}
function unregisterRun(groupId: string, r: ActiveRun) {
  const s = activeRuns.get(groupId);
  if (!s) return;
  s.delete(r);
  if (s.size === 0) activeRuns.delete(groupId);
}
/** 停止执行：不传 agentId = 停整个工作区（含编排与所有成员）；传 = 只停该成员当前任务 */
function stopRuns(groupId: string, agentId?: string): number {
  const s = activeRuns.get(groupId);
  if (!s) return 0;
  let n = 0;
  for (const r of s) {
    if (agentId && r.agentId !== agentId) continue;
    r.ctl.abort();
    n++;
  }
  return n;
}

// ---------- 人工审批（危险命令闸门）：run_shell 命中危险模式 → 图挂起 → 真人批准/拒绝后再续跑 ----------
interface PendingApproval {
  id: string;
  groupId: string;
  agentId: string;
  agentName: string;
  request: ApprovalRequest | null;
  createdAt: number;
  expiresAt: number;
  resolve: (d: { approved: boolean; note?: string } | null) => void;
}
const pendingApprovals = new Map<string, PendingApproval>();

/** 推给 UI 的待审批列表（不含 resolve 句柄；进工作区时补推，刷新不丢卡片） */
function publicApprovals(groupId: string) {
  return [...pendingApprovals.values()]
    .filter((p) => p.groupId === groupId)
    .map((p) => ({
      id: p.id, groupId: p.groupId, agentId: p.agentId, agentName: p.agentName,
      request: p.request, createdAt: p.createdAt, expiresAt: p.expiresAt,
    }));
}

/**
 * 发起一次审批等待：向工作区广播审批卡片，等真人决定 / 超时 / 任务被停止。
 * 返回 null = 无人处理（超时或被手动停止）——调用方据此收敛为"命令未执行"。
 * --- @ty.aicoding@1789442083508 ---
 */
function requestApproval(
  groupId: string,
  agent: AgentDef,
  request: ApprovalRequest | null,
  signal?: AbortSignal
): Promise<{ approved: boolean; note?: string } | null> {
  const id = newId("ap");
  const timeoutMs = settings.approval?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (d: { approved: boolean; note?: string } | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pendingApprovals.delete(id);
      io.to(groupId).emit("approvalResolved", {
        groupId, id, agentId: agent.id,
        approved: d ? d.approved : null, // null = 超时/被停止
        note: d?.note || "",
      });
      resolve(d);
    };
    const onAbort = () => finish(null);
    const item: PendingApproval = {
      id, groupId, agentId: agent.id, agentName: agent.name, request,
      createdAt: Date.now(), expiresAt: Date.now() + timeoutMs, resolve: finish,
    };
    if (signal?.aborted) {
      resolve(null); // 已停止：不登记、不广播
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    pendingApprovals.set(id, item);
    io.to(groupId).emit("approval", publicApprovals(groupId).find((p) => p.id === id)!);
  });
}

/**
 * 同成员串行队列（覆盖「挂起等审批」的整段时间）。
 * harness 内部也有一条同 (agent,cwd) 的排队链，但图一旦挂起等人批准它就返回了、链随之放行；
 * 此时若又来一条消息，第二个 run 会往同一条 thread 上写（把待恢复的 checkpoint 交错覆盖）。
 * 所以服务端再排一层，把审批等待期也纳入串行范围。
 * --- @ty.aicoding@1789442083508 ---
 */
const memberQueues = new Map<string, Promise<void>>();
function enqueueMemberTask(cwd: string, agentId: string, run: () => Promise<string>): Promise<string> {
  const key = `${agentId}\u0000${cwd}`;
  const prev = memberQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  memberQueues.set(key, next.then(() => {}, () => {}));
  return next;
}

/**
 * 单个 agent 处理一条工作区消息（外层入口：同成员串行排队后执行）。
 * --- @ty.aicoding@1789442083508 ---
 */
async function runAgentTask(
  groupId: string,
  agent: AgentDef,
  text: string,
  opts: {
    concurrentCount?: number; prompt?: string; post?: boolean; sender?: LoginUser | null;
    traceSink?: TraceEntry[]; parentSignal?: AbortSignal;
    responseFormat?: AgentResponseFormat; // 结构化输出（harness 能力保留；服务器当前不用——本机网关不认 tool_choice，见编排处注释）
    capture?: { structured?: unknown }; // 回填结构化结果（编排层据此拿分派计划）
  } = {}
): Promise<string> {
  const cwd = groupWorkspace(groupId, agent);
  return enqueueMemberTask(cwd, agent.id, () => runAgentTaskInner(groupId, agent, text, opts, cwd));
}

/**
 * 单个 agent 处理一条工作区消息：typing → 事件流 →（必要时人工审批）→ 回复 → 产物收集 → done。返回回复文本
 * --- @ty.aicoding@1789442083508 ---
 */
async function runAgentTaskInner(
  groupId: string,
  agent: AgentDef,
  text: string,
  opts: {
    concurrentCount?: number; prompt?: string; post?: boolean; sender?: LoginUser | null;
    traceSink?: TraceEntry[]; parentSignal?: AbortSignal;
    responseFormat?: AgentResponseFormat;
    capture?: { structured?: unknown };
  },
  cwd: string
): Promise<string> {
  const { concurrentCount = 1, post = true } = opts;
  const trace: TraceEntry[] = []; // 思考过程（推理步骤 + 工具调用 + 结果），随最终回复落盘展示
  const pushTrace = (entry: TraceEntry) => {
    trace.push(entry);
    if (opts.traceSink) opts.traceSink.push(entry); // 编排等外部调用方要拿全程过程（如 plan 可见版也带思考）
  };
  io.to(groupId).emit("typing", { groupId, agentId: agent.id, agentName: agent.name });

  const before = scanDir(cwd); // run 前快照，结束后 diff 出新产物
  const claimed = new Set<string>(); // 本轮显式写过/编辑过的文件（工具调用事件提取，产物归属用）
  // 排队可见性：该成员手上有任务在跑（slot 串行链），本条将排队等待
  if (runtimeManager.isBusy(agent.id, cwd)) {
    io.to(groupId).emit("agentEvent", { groupId, agentId: agent.id, agentName: agent.name, type: "queued", data: {} });
  }
  // 手动停止：本轮独立控制器；编排整体停止（parentSignal）触发时联动
  const ctl = new AbortController();
  const onParentAbort = () => ctl.abort();
  if (opts.parentSignal) {
    if (opts.parentSignal.aborted) ctl.abort();
    else opts.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const runReg = registerRun(groupId, agent.id, ctl);
  try {
    // 事件流 → 广播实时进度（step/tool 等），UI 展示"正在做什么"
    const progressEv = (ev: { type: string; data?: Record<string, unknown> }) => {
      // 审批卡片统一由 runAgentTask 广播（带 agent/超时/待审批列表），harness 的同名事件不重复转发
      if (ev.type === "approval/request") return;
      io.to(groupId).emit("agentEvent", {
        groupId,
        agentId: agent.id,
        agentName: agent.name,
        type: ev.type,
        data: ev.data || {},
      });
      const d = (ev.data || {}) as Record<string, unknown>;
      // 思考过程累积（随最终回复展示）+ 产物归属提取
      if (ev.type === "step/start") {
        const s = d.step;
        const stepTxt = typeof s === "number" ? `第 ${s + 1} 步` : (typeof s === "string" ? `步骤「${s}」` : contentToText(s) || "推进下一步");
        pushTrace({ kind: "step", text: stepTxt });
      } else if (/think|reasoning/i.test(ev.type)) {
        const t = contentToText(d.text ?? d.delta ?? d.content ?? d.message);
        if (t.trim()) pushTrace({ kind: "think", text: t.slice(0, 160) });
      } else if (ev.type === "tool/call") {
        const name = String(d.name || "tool");
        // arguments 是 JSON 字符串（非对象），需解析；file_path/path 多命名兼容
        let args = d.arguments as Record<string, unknown> | string | undefined;
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = undefined; }
        }
        const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        const brief = [a.command, a.cmd, a.path, a.file_path, a.query, a.pattern].find((v) => v != null && v !== "");
        pushTrace({ kind: "tool", text: `${TOOL_LABEL[name] || name}${brief != null ? " " + contentToText(brief).slice(0, 120) : ""}` });
        const p = a.file_path ?? a.path ?? a.filePath ?? a.filename;
        if (typeof p === "string" && p) {
          try {
            const abs = resolve(cwd, p);
            if (abs.startsWith(resolve(cwd) + sep) || abs === resolve(cwd)) claimed.add(relative(cwd, abs));
          } catch { /* 路径异常忽略 */ }
        }
      } else if (ev.type === "tool/result") {
        const m = d.message && typeof d.message === "object" ? (d.message as Record<string, unknown>) : {};
        const content = contentToText(m.content ?? m.output ?? d.content ?? d.output ?? d.result);
        const isErr = !!(m.isError || m.ok === false || d.error || d.isError);
        pushTrace({ kind: "result", ok: !isErr, text: isErr ? `工具执行出错：${content.slice(0, 80)}` : (content.slice(0, 160) || "完成") });
      }
    };
    // 多人被 @ 时限定各自职责范围，避免每个 agent 把整份任务清单都做一遍
    const scope = concurrentCount > 1 ? `\n注意：这条消息同时 @ 了 ${concurrentCount} 位同事并行工作，你是「${agent.name}（${agent.title}）」，只处理与你的职责相关的部分，其余部分由其他同事完成，不要代做。` : "";
    const task = opts.prompt || `${senderLabel(opts.sender)}：${text}\n请处理这个请求。若需要操作文件/命令，工作区即当前目录。${seedContext(groupId, agent, cwd)}${scope}`;
    // 执行（含审批闸门循环）：run_shell 命中危险命令时图会挂起（paused），
    // 这里广播审批请求 → 等真人「批准/拒绝」→ 带 resume 续跑同一条线程，直到跑完。
    // 续跑不再注入任务消息（task 传空），否则等于重复下达一遍指令。
    let result: Awaited<ReturnType<typeof runHarness>>;
    let resumeValue: unknown;
    let pauseUnresolved = false; // 审批无人处理（超时/被停止）
    for (;;) {
      result = await runHarness({
        agent,
        settings,
        task: resumeValue === undefined ? task : "",
        cwd,
        groupId, // 提供检索/记忆工具（search_history / search_workspace / remember / recall）
        timeoutMs: 600_000,
        onEvent: progressEv,
        signal: ctl.signal, // 手动停止
        resume: resumeValue,
        responseFormat: opts.responseFormat,
      });
      if (!result.paused) break;
      const req = (result.interrupt?.value ?? null) as ApprovalRequest | null;
      pushTrace({ kind: "think", text: `⏸ 高危命令等待真人批准：${req?.sample || req?.command || "(未取到命令)"}` });
      // 让 UI 的运行卡明确进入"已挂起等审批"态（否则卡片会停在"正在调用工具…"看着像卡死）
      io.to(groupId).emit("agentEvent", {
        groupId, agentId: agent.id, agentName: agent.name, type: "approval/wait",
        data: { sample: req?.sample || req?.command || "", risk: req?.risk || "" },
      });
      const decision = await requestApproval(groupId, agent, req, ctl.signal);
      if (decision === null) { pauseUnresolved = true; break; }
      resumeValue = decision;
    }
    if (opts.capture && result.structured !== undefined) opts.capture.structured = result.structured;
    // 收集本轮工作区新产物 → 工作区文件区（多并发时按工具调用事件精确归属）
    collectSandboxFiles(groupId, agent, cwd, before, { claimed, concurrentCount });
    // 新产物同步进检索索引（file_state 变更检测，未变文件零开销；异步让出主线程）
    try { await retrieval.indexDirAsync(groupId, agent.id, cwd); } catch { /* 索引失败不影响任务 */ }
    const replyText = pauseUnresolved
      ? "⏸ 检测到高危命令，等待真人批准，但无人处理（超时或被停止），该命令未执行。需要时请重新发起，或先在「设置 → 安全审批」里调整规则。"
      : result.aborted
      ? "（已手动停止本轮执行）"
      : result.ok
      ? (result.content?.trim() || "（本轮无文字回复，可查看工作区文件区产出）")
      : `（执行失败）\n${[result.error, result.stderr, result.content].find((s) => s && s.trim()) || "无错误详情"}`;
    if (post) postAgentReply(groupId, agent, replyText, trace);
    return replyText;
  } catch (e) {
    const errText = `出错了: ${(e as Error).message}`;
    pushTrace({ kind: "error", text: contentToText((e as Error)?.message || e, 200) });
    if (post) {
      io.to(groupId).emit("message", {
        id: newId("m"),
        groupId,
        senderId: agent.id,
        senderName: agent.name,
        kind: "text",
        text: errText,
        trace: trace.length ? trace : undefined,
        ts: Date.now(),
      } satisfies ChatMsg);
    }
    return errText;
  } finally {
    unregisterRun(groupId, runReg);
    if (opts.parentSignal) opts.parentSignal.removeEventListener("abort", onParentAbort);
    io.to(groupId).emit("done", { groupId, agentId: agent.id });
  }
}

// ---------- 项目总监编排：拆解 → dispatch 分派 → 依赖分波执行 → 汇总 ----------
// 拆解计划的数据契约（schema / 归一化 / 代码块兜底解析）统一放在 core/plan.ts，
// 这里只负责编排流程本身。

/** 依赖分波（Kahn 拓扑，借鉴 Agent Teams blockedBy）：同波内并行、波间串行。
 *  循环依赖兜底并入最后一波（不阻塞整体）；无依赖时全部进第一波 = 原纯并行行为。 */
function buildWaves(deps: number[][]): number[][] {
  const done = new Set<number>();
  const waves: number[][] = [];
  const rest = new Set(deps.map((_, i) => i));
  while (rest.size) {
    const wave = [...rest].filter((i) => deps[i].every((d) => done.has(d)));
    if (!wave.length) break; // 出现循环依赖：剩余任务兜底并波
    for (const i of wave) {
      rest.delete(i);
      done.add(i);
    }
    waves.push(wave);
  }
  if (rest.size) waves.push([...rest]);
  return waves;
}

/** 宽松匹配工作区内成员：短名/全名/id 任一命中 */
function matchAgent(groupId: string, name: string): AgentDef | undefined {
  const n = (name || "").trim();
  if (!n) return undefined;
  return memberAgents(groupId).find(
    (a) => a.id === n || a.shortName === n || a.name === n || a.name.includes(n) || n.includes(a.shortName)
  );
}

/**
 * 解析子任务回报里的结构化三段（【结果】【产出】【风险】）。
 * 实现放在 core/plan.ts（与拆解计划同属"编排数据契约"，也便于离线单测）。
 * --- @ty.aicoding@1789443562072 ---
 */

async function runLeadOrchestration(groupId: string, lead: AgentDef, text: string, sender?: LoginUser | null) {
  // 编排整体控制器：一键停止 = 拆解/子任务/汇总全停，且未启动的后续波次不再启动
  const orchCtl = new AbortController();
  const orchReg = registerRun(groupId, ORCH_AGENT_KEY, orchCtl);
  try {
    return await runLeadOrchestrationInner(groupId, lead, text, sender, orchCtl);
  } finally {
    unregisterRun(groupId, orchReg);
  }
}

async function runLeadOrchestrationInner(groupId: string, lead: AgentDef, text: string, sender: LoginUser | null | undefined, orchCtl: AbortController) {
  const runId = newId("orch");
  /** 编排看板事件：plan → dispatch → task(running/done/error) → summary → end（落盘可重放） */
  const orchEv = (payload: Record<string, unknown>) => {
    const ev = { groupId, runId, leadId: lead.id, leadShortName: lead.shortName, ts: Date.now(), ...payload };
    io.to(groupId).emit("orchestration", ev);
    store.appendLine(`orchestrations/${groupId}.jsonl`, ev); // 落盘：重进入工作区可重放看板
  };
  orchEv({ phase: "plan", request: text.slice(0, 120) });

  const roster = memberAgents(groupId)
    .filter((a) => a.id !== lead.id)
    .map((a) => `${a.shortName}（${a.name}/${a.title}）`)
    .join("、");
  const prompt = `${senderLabel(sender)}：${text}

你是项目总监，负责拆解需求并分派给团队。请：
1) 先用两三句话向工作区里说明你对需求的理解和分工计划（这部分会直接展示给所有人，不要包含代码块）。
2) 若需要成员协作，在最后输出一个 dispatch 代码块（严格 JSON，格式如下）：
\`\`\`dispatch
{"subtasks":[{"agent":"成员短名","task":"具体子任务，含足够上下文"},{"agent":"...","task":"...","dependsOn":[1]}],"self":"你自己要动手做的部分，没有则留空"}
\`\`\`
可用成员：${roster}。
注意：task 要具体可执行且小而聚焦——单个子任务正常应在十几步工具操作内完成，预估更大的必须再拆细（宁多拆一个子任务，也别让成员一轮跑不完）；某子任务必须等另一子任务完成才能执行时（如测试要等接口文档写完），在该子任务的 dependsOn 里填它依赖的子任务序号（从 1 开始），无依赖不要填、能并行的尽量并行；不需要协作的简单需求直接自己回答并输出 {"subtasks":[],"self":""}；子任务最多 4 个。`;

  // ① 王大锤拆解（不直接发到工作区，先解析 dispatch 再发干净版本）；全程思考过程透传给可见计划版
  //
  // 分派计划**只走正文里的 dispatch 代码块**（提示词已强制要求），不再用 langgraph 的 responseFormat。
  // 实测（2026-09-15，deepseek-v4-flash 经 codeworks 网关，Anthropic 协议）：该网关**不认 tool_choice**——
  // 同一份拆解提示词下，不带 / {type:auto} / {type:any} / {type:tool,name} 四种写法**全部**返回
  // `text + end_turn`，模型一律用正文回答（换成"只准调函数"的提示词它才肯调，说明 tool_use 本身可用、
  // 只是 tool_choice 约束被忽略）。于是 generate_structured_response 节点每次都取不到 tool_call、抛
  // `No tool calls found in the response.`，把整轮变成（执行失败）气泡——真人 @总监 说句"你好"就炸。
  // 带 responseFormat 还有个固定代价：每轮多一次模型调用（图末尾的结构化节点）。
  // 故改为单次调用 + 正文解析：JSON 合法性由 parseDispatchBlock 校验，写了块但 JSON 非法时
  // 下面会 orchEv(parse-error) 明确报给真人（不会静默当成"无需分派"）。
  const leadTrace: TraceEntry[] = [];
  const planText = await runAgentTask(groupId, lead, text, {
    prompt, post: false, sender, traceSink: leadTrace, parentSignal: orchCtl.signal,
  });
  if (orchCtl.signal.aborted) { // 拆解阶段被手动停止：不发计划，直接收板
    orchEv({ phase: "end", ok: false, note: "stopped" });
    return;
  }

  if (settings.orchestrate === false) {
    postAgentReply(groupId, lead, planText, leadTrace.length ? leadTrace : undefined); // 编排关闭时退化为普通回复（带思考）
    orchEv({ phase: "end", ok: true, note: "direct" });
    return;
  }

  // 计划来源：正文里的 dispatch 代码块（strict JSON → 合法性归一化 + malformed 显式报错）
  const block = parseDispatchBlock(planText);
  const plan: DispatchPlan | null = block.plan;
  const visible = planText.replace(DISPATCH_RE, "").trim() || "收到需求，我来安排分工。";
  postAgentReply(groupId, lead, visible, leadTrace.length ? leadTrace : undefined);
  if (!plan) {
    if (block.malformed) {
      // 写了 dispatch 块但 JSON 不合法：旧实现静默当成"无需分派"（真人只看到计划、没人开工却不知为何）
      orchEv({ phase: "end", ok: false, note: "parse-error" });
      postAgentReply(groupId, lead, "⚠️ 我给出了分工计划，但格式不合法、没能解析出子任务，因此这次没有成员被分派。请再发一次需求，或直接把任务 @ 给具体成员。", undefined);
      return;
    }
    orchEv({ phase: "end", ok: true, note: "no-dispatch" }); // 无有效分派（简单需求已直接回答）
    return;
  }

  // ② 分派：按 dependsOn 依赖分波（同波并行、波间串行）+ 王大锤自己那份
  const jobs: Array<{ agent: AgentDef; task: string; deps: number[] }> = [];
  const subIdxToJob = new Map<number, number>(); // 子任务序号(0-based) → job 下标（无效子任务被丢弃时跳号）
  for (const [i, st] of plan.subtasks.entries()) {
    const agent = st.agent ? matchAgent(groupId, st.agent) : undefined;
    if (agent && agent.id !== lead.id && st.task?.trim()) {
      subIdxToJob.set(i, jobs.length);
      jobs.push({ agent, task: st.task.trim(), deps: [] });
    }
  }
  const selfText = plan.self?.trim() || "";
  const selfJobIdx = selfText ? jobs.length : -1;
  if (selfJobIdx >= 0) jobs.push({ agent: lead, task: selfText, deps: [] });
  // 依赖序号映射到 job 下标（指向被丢弃子任务的依赖忽略；自指已在解析层过滤）
  for (const [i, st] of plan.subtasks.entries()) {
    const j = subIdxToJob.get(i);
    if (j === undefined || !st.dependsOn?.length) continue;
    jobs[j].deps = st.dependsOn
      .map((d) => subIdxToJob.get(d))
      .filter((d): d is number => d !== undefined && d !== j);
  }
  // lead 的 self 任务默认排最后一波：它通常是「核查/整理」性质，需要看到全部成员产出——
  // 修复此前 self 固定第一波导致「产出尚未产生」的中间态误报（且它自带只读工具，核查语义成立）
  if (selfJobIdx >= 0) {
    jobs[selfJobIdx].deps = jobs.map((_, i) => i).filter((i) => i !== selfJobIdx);
  }
  if (jobs.length === 0) {
    orchEv({ phase: "end", ok: true, note: "empty-jobs" });
    return;
  }
  const waves = buildWaves(jobs.map((j) => j.deps));
  const waveOf = new Array<number>(jobs.length);
  waves.forEach((w, wi) => w.forEach((i) => (waveOf[i] = wi)));
  orchEv({
    phase: "dispatch",
    plan: visible.slice(0, 800),
    tasks: jobs.map((j, i) => ({
      agentId: j.agent.id, agentShortName: j.agent.shortName,
      task: j.task.slice(0, 100), wave: waveOf[i],
    })),
  });

  const isErrText = (s: string) => s.startsWith("出错了") || s.includes("（执行失败");
  // 成员回报裁剪（借鉴 Claude「subagent 只回一条消息」铁律）：群里展示全文，
  // 但 lead 汇总时只吃头尾摘要——防多个成员的超长输出把 lead 的上下文挤爆。
  const clipReport = (s: string, cap = 2400) =>
    s.length <= cap ? s : s.slice(0, 1000) + "\n…（中间内容略）…\n" + s.slice(-1200);
  const results = new Array<PromiseSettledResult<string>>(jobs.length);

  const runJob = async (i: number): Promise<void> => {
    const { agent, task, deps } = jobs[i];
    orchEv({ phase: "task", agentId: agent.id, agentShortName: agent.shortName, status: "running" });
    // 下游提示：上游产出已在群聊（结构化回报）与工作区（文件），检索/直读即可——复用检索层
    // 上游产物透传：直接注入上游结构化回报（Supervisor 标准模式——下游不吃群聊全量，
    // 只吃自己依赖的那几份），并注明上游文件位置与获取方式（跨沙箱时用检索拿内容要点）。
    const depNote = deps.length
      ? `\n\n你依赖的前置子任务已完成，上游回报如下：\n${deps
          .map((d) => {
            const r = results[d];
            const out = r?.status === "fulfilled" ? clipReport(r.value, 1200) : `（执行失败: ${r?.reason ?? "未执行"}）`;
            return `【${jobs[d].agent.shortName}】${out}`;
          })
          .join("\n\n")}\n上游产出的文件位于上游成员的工作区：若你的工作区读不到它（各成员沙箱相互隔离），用 search_workspace 检索其内容、或以群聊里的上游回报为准。若上游失败，基于现状尽力完成并在回报中说明。`
      : "";
    try {
      if (orchCtl.signal.aborted) { // 尚未启动的波次任务：停止后不再启动
        results[i] = { status: "rejected", reason: "stopped" };
        orchEv({ phase: "task", agentId: agent.id, agentShortName: agent.shortName, status: "stopped", summary: "已手动停止，未启动" });
        return;
      }
      const out = await runAgentTask(groupId, agent, "", {
        prompt: `项目总监「${lead.shortName}」把需求拆解后分派给你这个子任务：${task}\n（原始需求：${text}）\n请处理。若需要操作文件/命令，工作区即当前目录。${depNote}\n完成后回报必须按此结构（简洁，≤500字）：\n【结果】完成了什么/结论是什么\n【产出】改动或新增的文件路径（没有则写"无"）\n【风险】未尽事项或需要总监注意的风险（没有则写"无"）`,
        concurrentCount: jobs.length,
        sender,
        parentSignal: orchCtl.signal,
      });
      results[i] = { status: "fulfilled", value: out };
      // 结构化回报（【结果】【产出】【风险】）就地解析成字段：看板能直接统计"产出/风险"，
      // 不必再开一次 withStructuredOutput（成员本来就被要求在回报里写这三段）。
      const rep = parseReport(out);
      orchEv({
        phase: "task", agentId: agent.id, agentShortName: agent.shortName,
        status: out.startsWith("（已手动停止") ? "stopped" : isErrText(out) ? "error" : "done",
        summary: (rep?.result || out.replace(/\n/g, " ")).slice(0, 120),
        report: rep || undefined,
      });
    } catch (e) {
      results[i] = { status: "rejected", reason: String((e as Error)?.message || e) };
      orchEv({
        phase: "task", agentId: agent.id, agentShortName: agent.shortName,
        status: "error", summary: String((e as Error)?.message || e).slice(0, 120),
      });
    }
  };

  // 波间串行、波内并行：第一波无依赖任务先跑，依赖任务等上游完成再启动
  for (const wave of waves) {
    if (orchCtl.signal.aborted) break; // 手动停止：后续波次不再启动
    await Promise.allSettled(wave.map((i) => runJob(i)));
  }
  if (orchCtl.signal.aborted) { // 停止后跳过汇总，直接收板
    orchEv({ phase: "end", ok: false, note: "stopped" });
    return;
  }

  // ③ 王大锤基于各成员回报做汇总（结构化回报 + 裁剪，lead 不吃全文）
  const report = jobs
    .map((j, i) => {
      const r = results[i];
      const out = r?.status === "fulfilled" ? clipReport(r.value) : `（执行失败: ${r?.reason ?? "未执行"}）`;
      return `【${j.agent.shortName}】${out}`;
    })
    .join("\n\n");
  orchEv({ phase: "summary", status: "running" });
  await runAgentTask(groupId, lead, "", {
    prompt: `你分派的子任务已全部完成，各成员的结构化回报如下（【结果】【产出】【风险】三段）：\n\n${report}\n\n（原始需求：${text}）\n请基于以上回报汇总验收结论，向真人${sender?.name || "用户"}做简短汇报（要点式：各成员产出与整体完成度、有无风险待办）。不需要重新读文件核对，成员回报即为结果。`,
    parentSignal: orchCtl.signal,
  });
  orchEv({ phase: "summary", status: "done" });
  orchEv({ phase: "end", ok: !orchCtl.signal.aborted, ...(orchCtl.signal.aborted ? { note: "stopped" } : {}) });
}

io.on("connection", (socket) => {
  socket.data.groupId = null; // 当前查看的群
  socket.data.user = null;
  socket.data.token = "";

  // 会话恢复：握手 auth.token（登录时签发，localStorage 持久化）→ 免查库恢复登录人；
  // 未带/无效 token → 匿名，UI 由登录门禁接管，看不到任何工作区
  const authed = bindAuth(socket);
  syncRooms(socket); // 只加入自己有权查看的工作区房间
  pushGroupsTo(socket); // 按身份推送可见工作区列表（匿名 = 空列表）

  socket.emit("agents", publicAgents());
  socket.emit("settings", publicSettings());
  socket.emit("gitEnv", gitEnvState());

  // 真人通讯录（全量在职员工）：缓存就绪直接推；否则占位后异步拉取（成功后 refreshStaff 统一广播）
  if (staffState === "ready") {
    socket.emit("staff", publicStaff());
  } else {
    socket.emit("staff", []);
    void refreshStaff();
  }
  socket.emit("me", { user: authed ? socket.data.user : null });

  // 手动登录：输入域账号校验在职员工 → 签发会话 token（同账号单活：顶掉并踢下线旧会话）
  socket.on("login", async (payload: { account?: string }, ack?: (r: unknown) => void) => {
    const r = await resolveLogin(payload?.account || "");
    if (!r.ok || !r.user) {
      ack?.({ ok: false, error: r.error || "登录失败" });
      return;
    }
    const token = issueSession(r.user);
    const sess = sessions.get(token);
    if (sess) sess.socketId = socket.id; // 绑定当前连接 → 同账号再登录时可踢掉本端
    socket.data.user = r.user;
    socket.data.token = token;
    syncRooms(socket);
    pushGroupsTo(socket); // 登录后只推自己有权进入的群
    ack?.({ ok: true, user: r.user, token });
    socket.emit("me", { user: r.user });
  });

  // 退出登录：作废本会话 token（仅影响当前端），清空身份并回到匿名视野
  socket.on("logout", (_payload: unknown, ack?: (r: unknown) => void) => {
    if (socket.data.token) revokeSession(socket.data.token);
    socket.data.user = null;
    socket.data.token = "";
    syncRooms(socket);
    pushGroupsTo(socket);
    ack?.({ ok: true });
    socket.emit("me", { user: null });
  });

  // 会话凭据补登：页面通常是「匿名建连 → 登录后才拿到 token」，此类连接的 socket 初始 auth 不带 token；
  // 断线重连（后台标签冻结/网络波动/服务重启触发 socket.io 自动重连）后服务端会按匿名处理。
  // 客户端在每次连接建立后用本地 token 主动换回身份（等效 bindAuth，不触发同账号单活顶号）。
  socket.on("restore", (payload: { token?: string }, ack?: (r: unknown) => void) => {
    const token = typeof payload?.token === "string" ? payload.token : "";
    const sess = token ? sessions.get(token) : undefined;
    if (!sess || Date.now() - sess.createdAt > SESSION_TTL_MS) {
      if (sess) revokeSession(token); // 过期会话顺带作废
      ack?.({ ok: false });
      return;
    }
    sess.socketId = socket.id;
    socket.data.user = sess.user;
    socket.data.token = token;
    syncRooms(socket);
    pushGroupsTo(socket);
    ack?.({ ok: true, user: sess.user });
    socket.emit("me", { user: sess.user });
  });

  // 断线：解绑 socketId（token 保留 → 7 天内刷新/重连免登录；若同账号已在别处登录则旧 token 已作废）
  socket.on("disconnect", () => {
    const token = socket.data.token as string | undefined;
    if (token) {
      const sess = sessions.get(token);
      if (sess && sess.socketId === socket.id) sess.socketId = null;
    }
  });

  // 设置更新：全局开关 + LLM 接入（协议/地址/Token/模型）+ 联网（web_fetch / web_search）。
  // 协议/地址/模型/Token 变更会清空会话缓存（下轮生效）；联网工具每轮现构建，无需清缓存。
  socket.on("updateSettings", (patch: {
    autoReply?: unknown; orchestrate?: unknown; model?: unknown;
    protocol?: unknown; baseUrl?: unknown; apiKey?: unknown; apiKeyClear?: unknown;
    contextTokens?: unknown; // 上下文窗口手动覆盖：正数=设置，null/0=清除（回到按模型名自动识别）
    fallbackModel?: unknown; fallbackProtocol?: unknown; fallbackBaseUrl?: unknown;
    fallbackKey?: unknown; fallbackKeyClear?: unknown;
    approvalEnabled?: unknown; approvalTimeout?: unknown; approvalExtraPatterns?: unknown;
    webEnabled?: unknown; webAllowPrivate?: unknown; webFetchTimeout?: unknown; webFetchMaxChars?: unknown;
    webSearchProvider?: unknown; webSearchBaseUrl?: unknown; webSearchKey?: unknown; webSearchKeyClear?: unknown;
    webSearchCount?: unknown;
  }, ack?: (r: unknown) => void) => {
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
    const s = settings;
    // 联网：搜索地址先整体校验（避免半套变更留在内存却没落盘）
    if (typeof patch?.webSearchBaseUrl === "string") {
      const v = patch.webSearchBaseUrl.trim();
      if (v && !/^https?:\/\//i.test(v)) {
        ack?.({ ok: false, error: "搜索地址需以 http(s):// 开头，如 http://192.168.1.10:8080" });
        return;
      }
    }
    // 备用模型地址同样前置校验
    if (typeof patch?.fallbackBaseUrl === "string") {
      const v = patch.fallbackBaseUrl.trim();
      if (v && !/^https?:\/\//i.test(v)) {
        ack?.({ ok: false, error: "备用模型地址需以 http(s):// 开头" });
        return;
      }
    }
    // 审批附件模式：逐条编译正则，写错就整批拒绝（比静默忽略更不容易踩坑）
    let approvalPatterns: string[] | undefined;
    if (typeof patch?.approvalExtraPatterns === "string") {
      const lines = patch.approvalExtraPatterns.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 20);
      for (const line of lines) {
        if (line.length > 200) { ack?.({ ok: false, error: `自定义危险模式过长（≤200 字符）：${line.slice(0, 40)}…` }); return; }
        try { new RegExp(line); } catch { ack?.({ ok: false, error: `自定义危险模式不是合法正则：${line}` }); return; }
      }
      approvalPatterns = lines;
    }
    if (typeof patch?.autoReply === "boolean") s.autoReply = patch.autoReply;
    if (typeof patch?.orchestrate === "boolean") s.orchestrate = patch.orchestrate;
    let llmChanged = false; // llm 连接相关变化 → 清空会话缓存（换协议/地址/模型/Token）
    const llm = s.llm;
    // 协议：openai（OpenAI 兼容，含 DeepSeek）| anthropic（Claude / DeepSeek anthropic 端点）
    if (typeof patch?.protocol === "string") {
      const p = patch.protocol.trim().toLowerCase();
      if (p === "openai" || p === "anthropic") {
        if ((llm.protocol || "openai") !== p) { llm.protocol = p; llmChanged = true; }
      }
    }
    // API 地址（留空用协议默认：openai→api.deepseek.com / anthropic→api.anthropic.com）
    if (typeof patch?.baseUrl === "string") {
      const raw = patch.baseUrl.trim();
      const v = raw ? raw.slice(0, 200) : "";
      if (v && !/^https?:\/\//i.test(v)) {
        ack?.({ ok: false, error: "API 地址需以 http(s):// 开头，如 https://api.deepseek.com" });
        return;
      }
      if ((llm.baseUrl || "") !== v) { llm.baseUrl = v || undefined; llmChanged = true; }
    }
    // API Token：填了更新；空=保留已存（另用 apiKeyClear 显式清除）。不回传 UI，仅 hasKey 提示。
    if (patch?.apiKeyClear === true) {
      if (llm.apiKey) { delete llm.apiKey; llmChanged = true; }
    } else if (typeof patch?.apiKey === "string" && patch.apiKey.trim()) {
      const k = patch.apiKey.trim().slice(0, 512);
      if (k !== (llm.apiKey || "")) { llm.apiKey = k; llmChanged = true; }
    }
    // 模型
    if (typeof patch?.model === "string" && patch.model.trim()) {
      const m = str(patch.model, 60)!;
      if (m !== (llm.model || "")) { llm.model = m; llmChanged = true; }
    }
    // 上下文窗口（tokens）：手动覆盖按模型名自动识别。正数=设置；null/0/负数=清除（回到自动识别）。
    // 不算 llmChanged：窗口只影响裁剪范围，不换模型/协议，无需清空会话缓存。
    if (patch?.contextTokens !== undefined) {
      const n = Number(patch.contextTokens);
      if (Number.isFinite(n) && n >= 8_000) {
        llm.contextTokens = Math.floor(n);
      } else {
        delete llm.contextTokens; // 清除覆盖，回到按模型名自动识别
      }
    }
    // ---- 联网配置（web_fetch / web_search）：开关、限额、搜索后端 ----
    const web = (s.web ??= {});
    if (typeof patch?.webEnabled === "boolean") web.enabled = patch.webEnabled;
    if (typeof patch?.webAllowPrivate === "boolean") web.allowPrivateHosts = patch.webAllowPrivate;
    // 抓取超时（ms，界面按秒填）：2s~120s；空/非法=清除回落默认 20s
    if (patch?.webFetchTimeout !== undefined) {
      const n = Number(patch.webFetchTimeout);
      if (Number.isFinite(n) && n >= 2_000 && n <= 120_000) web.fetchTimeoutMs = Math.floor(n);
      else delete web.fetchTimeoutMs;
    }
    // 正文上限（字符）：500~60000；空/非法=清除回落默认 8000
    if (patch?.webFetchMaxChars !== undefined) {
      const n = Number(patch.webFetchMaxChars);
      if (Number.isFinite(n) && n >= 500 && n <= 60_000) web.fetchMaxChars = Math.floor(n);
      else delete web.fetchMaxChars;
    }
    const search = (web.search ??= {});
    if (typeof patch?.webSearchProvider === "string") {
      const p = patch.webSearchProvider.trim().toLowerCase();
      if (["bing", "duckduckgo", "searxng", "bocha", "tavily", "off"].includes(p)) search.provider = p as WebSearchProvider;
    }
    if (typeof patch?.webSearchBaseUrl === "string") {
      const v = patch.webSearchBaseUrl.trim().slice(0, 300);
      search.baseUrl = v || undefined; // searxng 实例地址 / 自定义端点；协议已在函数开头校验过
    }
    // 搜索 key：填了更新；空=保留已存（另用 webSearchKeyClear 显式清除）。不回传 UI，仅 hasKey 提示。
    if (patch?.webSearchKeyClear === true) delete search.apiKey;
    else if (typeof patch?.webSearchKey === "string" && patch.webSearchKey.trim()) {
      search.apiKey = patch.webSearchKey.trim().slice(0, 512);
    }
    if (patch?.webSearchCount !== undefined) {
      const n = Number(patch.webSearchCount);
      if (Number.isFinite(n) && n >= 1 && n <= 20) search.count = Math.floor(n);
      else delete search.count;
    }
    // ---- 备用模型（主模型单次调用失败时降级）：模型名为空=关闭；key 只存本机 ----
    if (typeof patch?.fallbackModel === "string") {
      const m = patch.fallbackModel.trim().slice(0, 80);
      if (!m) delete llm.fallback;
      else llm.fallback = { ...(llm.fallback || {}), model: m };
    }
    if (llm.fallback) {
      if (typeof patch?.fallbackProtocol === "string") {
        const p = patch.fallbackProtocol.trim().toLowerCase();
        if (p === "openai" || p === "anthropic") llm.fallback.protocol = p;
        else delete llm.fallback.protocol;
      }
      if (typeof patch?.fallbackBaseUrl === "string") {
        const v = patch.fallbackBaseUrl.trim().slice(0, 200);
        if (v) llm.fallback.baseUrl = v;
        else delete llm.fallback.baseUrl;
      }
      if (patch?.fallbackKeyClear === true) delete llm.fallback.apiKey;
      else if (typeof patch?.fallbackKey === "string" && patch.fallbackKey.trim()) {
        llm.fallback.apiKey = patch.fallbackKey.trim().slice(0, 512);
      }
    }
    // ---- 危险命令人工审批闸门（run_shell）----
    const ap = (s.approval ??= {});
    if (typeof patch?.approvalEnabled === "boolean") ap.enabled = patch.approvalEnabled;
    if (patch?.approvalTimeout !== undefined) {
      const n = Number(patch.approvalTimeout);
      if (Number.isFinite(n) && n >= 30_000 && n <= 3_600_000) ap.timeoutMs = Math.floor(n);
      else delete ap.timeoutMs; // 空/非法=回落默认 10 分钟
    }
    if (approvalPatterns !== undefined) {
      if (approvalPatterns.length) ap.extraPatterns = approvalPatterns;
      else delete ap.extraPatterns;
    }
    saveSettings();
    ack?.({ ok: true });
    io.emit("settings", publicSettings());
    if (llmChanged) void shutdownHarness(); // 清空会话缓存，下轮按新配置生效
  });

  // 成员编辑：白名单字段校验后生效（persona/rules 会进下一轮任务的系统提示）
  // --- @ty.aicoding@1789436639812 ---
  socket.on("updateAgent", (patch: Record<string, unknown>, ack?: (r: unknown) => void) => {
    const a = settings.agents.find((x) => x.id === patch?.id);
    if (!a) {
      ack?.({ ok: false, error: "agent 不存在" });
      return;
    }
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
    const name = str(patch.name, 30);
    if (name) a.name = name;
    const shortName = str(patch.shortName, 12);
    if (shortName) a.shortName = shortName;
    const title = str(patch.title, 40);
    if (title !== undefined && title) a.title = title;
    const color = typeof patch.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(patch.color) ? patch.color : undefined;
    if (color) a.color = color;
    const avatar = str(patch.avatar, 8);
    if (avatar) a.avatar = avatar;
    const persona = str(patch.persona, 2000);
    if (persona !== undefined) a.persona = persona;
    if (Array.isArray(patch.rules)) {
      a.rules = (patch.rules as unknown[])
        .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
        .map((r) => r.trim().slice(0, 200))
        .slice(0, 10);
    }
    // 工具白名单：null 或空数组 = 解除限制（全量）；数组按已知工具名过滤
    if (patch.tools === null || Array.isArray(patch.tools)) {
      const KNOWN_TOOLS = [
        "read_file", "write_file", "list_dir", "run_shell",
        "search_history", "search_workspace",
        "remember", "recall", // 工作区共享长期记忆（读写）
        "web_fetch", "web_search", // 联网工具（受 设置 → 联网 总开关约束）
      ];
      const list = Array.isArray(patch.tools)
        ? (patch.tools as unknown[]).filter((t): t is string => typeof t === "string" && KNOWN_TOOLS.includes(t))
        : [];
      if (list.length) a.tools = list;
      else delete a.tools;
    }
    // 模型覆盖（角色级路由，留空 = 继承全局）
    if (typeof patch.llmModel === "string") {
      const m = patch.llmModel.trim().slice(0, 80);
      if (m) a.llm = { ...(a.llm || {}), model: m };
      else if (a.llm) {
        const rest = { ...a.llm };
        delete rest.model;
        a.llm = Object.keys(rest).length ? rest : undefined;
      }
    }
    saveSettings();
    ack?.({ ok: true });
    io.emit("agents", publicAgents()); // 所有客户端刷新成员/昵称/头像
  });

  // 新增自定义成员：昵称唯一校验 → 建沙箱 → 自动加入所有工作区 → 广播
  socket.on("createAgent", (patch: Record<string, unknown>, ack?: (r: unknown) => void) => {
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const shortName = str(patch?.shortName, 12);
    if (!shortName) {
      ack?.({ ok: false, error: "昵称必填" });
      return;
    }
    if (settings.agents.some((a) => a.shortName === shortName)) {
      ack?.({ ok: false, error: `昵称「${shortName}」已存在` });
      return;
    }
    const ROLES = ["fe", "be", "qa", "ops", "design", "lead"];
    const role = ROLES.includes(patch?.role as string) ? (patch!.role as string) : "be";
    const name = str(patch?.name, 30) || shortName;
    const agent: AgentDef = {
      id: newId("ai"),
      role: role as AgentDef["role"],
      name,
      shortName,
      title: str(patch?.title, 40) || name,
      color: typeof patch?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(patch.color) ? patch.color : "#576b95",
      avatar: str(patch?.avatar, 8) || "🤖",
      persona: str(patch?.persona, 2000) || `你是${name}（${shortName}），请在设置中补充职责描述。`,
      rules: Array.isArray(patch?.rules)
        ? (patch!.rules as unknown[]).filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim().slice(0, 200)).slice(0, 10)
        : [],
    };
    settings.agents.push(agent);
    mkdirSync(join(settings.sandboxDir, agent.id), { recursive: true });
    const groups = loadGroups();
    for (const g of groups) g.memberIds = [...g.memberIds, agent.id];
    saveGroups(groups);
    saveSettings();
    ack?.({ ok: true, agent });
    io.emit("agents", publicAgents());
    pushGroupsAll();
  });

  // 删除自定义成员（内置不可删）：从所有工作区移出，历史消息与文件保留
  socket.on("deleteAgent", (payload: { id?: string }, ack?: (r: unknown) => void) => {
    const id = payload?.id || "";
    if (BUILTIN_IDS.has(id)) {
      ack?.({ ok: false, error: "内置成员不可删除，可在设置中修改人设" });
      return;
    }
    const idx = settings.agents.findIndex((a) => a.id === id);
    if (idx < 0) {
      ack?.({ ok: false, error: "成员不存在" });
      return;
    }
    settings.agents.splice(idx, 1);
    const groups = loadGroups();
    for (const g of groups) g.memberIds = g.memberIds.filter((m) => m !== id);
    saveGroups(groups);
    saveSettings();
    ack?.({ ok: true });
    io.emit("agents", publicAgents());
    pushGroupsAll();
  });

  // （真人通讯录 = 全量在职员工，随 staff 事件推送；真人进入工作区通过 updateGroupMembers/createGroup 勾选员工）

  // 加人/调可见性：需登录且是工作区成员（全员工作区人人都是成员）。memberIds 按"并集"合并，
  // 不因并发/重复提交丢成员；open 三态：true=全员工作区(human 开放位) / false=私有工作区 / 缺省=维持现状。
  socket.on("updateGroupMembers", (payload: { groupId?: string; memberIds?: unknown; open?: unknown }, ack?: (r: unknown) => void) => {
    const user = socket.data.user as LoginUser | null | undefined;
    if (!user) {
      ack?.({ ok: false, code: "NOT_LOGIN", error: "请先登录后再管理工作区成员" });
      return;
    }
    const groups = loadGroups();
    const g = groups.find((x) => x.id === (payload?.groupId || ""));
    if (!g) {
      ack?.({ ok: false, error: "工作区不存在" });
      return;
    }
    if (!groupAllowedFor(g, user)) {
      ack?.({ ok: false, code: "NOT_MEMBER", error: "你不是本工作区成员，无法管理成员" });
      return;
    }
    const valid = memberValidIds();
    const set = new Set(g.memberIds.filter((m) => valid.has(m) && m !== "human"));
    if (Array.isArray(payload?.memberIds)) {
      for (const m of payload!.memberIds) {
        if (typeof m === "string" && valid.has(m) && m !== "human") set.add(m);
      }
    }
    if (set.size === 0) {
      ack?.({ ok: false, error: "工作区内至少要保留一名成员" });
      return;
    }
    if (payload?.open === true) set.add("human");
    else if (payload?.open === false) set.delete("human");
    if (!set.has("human")) set.add(user.id); // 私有工作区：操作者/创建者恒在，防止把自己移出去
    g.memberIds = [...set];
    saveGroups(groups);
    ack?.({ ok: true });
    pushGroupsAll();
  });

  // 工作区信息编辑：改名 / 改描述 / 绑定工作目录（需登录且是工作区成员）
  socket.on("updateGroup", (payload: { groupId?: string; name?: string; desc?: string; workspace?: string }, ack?: (r: unknown) => void) => {
    const user = socket.data.user as LoginUser | null | undefined;
    const groups = loadGroups();
    const g = groups.find((x) => x.id === (payload?.groupId || ""));
    if (!g) {
      ack?.({ ok: false, error: "工作区不存在" });
      return;
    }
    if (!user || !groupAllowedFor(g, user)) {
      ack?.({ ok: false, code: "NOT_MEMBER", error: "你不是本工作区成员，无法编辑工作区信息" });
      return;
    }
    const name = (payload?.name || "").trim().slice(0, 30);
    const desc = (payload?.desc || "").trim().slice(0, 60);
    if (payload?.name !== undefined && !name) {
      ack?.({ ok: false, error: "工作区名称不能为空" });
      return;
    }
    if (name) g.name = name;
    if (payload?.desc !== undefined) g.desc = desc;
    if (payload?.workspace !== undefined) {
      const ws = payload.workspace.trim();
      if (ws) {
        // 必须是已存在的目录（防 typo 建出意外目录）；agent 将获得该目录的读写权限
        if (!existsSync(ws) || !statSync(ws).isDirectory()) {
          ack?.({ ok: false, error: `目录不存在: ${ws}` });
          return;
        }
        g.workspace = ws;
      } else {
        g.workspace = undefined; // 清空 → 回到各自沙箱
      }
    }
    saveGroups(groups);
    ack?.({ ok: true });
    pushGroupsAll();
  });

  // Git 仓库：填 http(s) 克隆地址 → clone/更新到 data/git/<groupId> → 绑定为工作区绑定目录
  // （需登录且是工作区成员；URL 可内嵌账号 http(s)://user:pass@…，凭据仅本次 git 会话使用，不落盘）
  socket.on(
    "cloneGroupRepo",
    async (payload: { groupId?: string; url?: string }, ack?: (r: unknown) => void) => {
      const user = socket.data.user as LoginUser | null | undefined;
      const groups = loadGroups();
      const g = groups.find((x) => x.id === (payload?.groupId || ""));
      if (!g) {
        ack?.({ ok: false, error: "工作区不存在" });
        return;
      }
      if (!user || !groupAllowedFor(g, user)) {
        ack?.({ ok: false, code: "NOT_MEMBER", error: "你不是本工作区成员，无法配置 Git 仓库" });
        return;
      }
      const url = (payload?.url || "").trim().slice(0, 500);
      if (!/^https?:\/\//i.test(url)) {
        ack?.({ ok: false, error: "仅支持 http(s) 开头的 git 克隆地址" });
        return;
      }
      const env = gitEnvState();
      if (env.status === "installing") {
        ack?.({ ok: false, error: "git 环境正在后台安装中，请稍候片刻再试…" });
        return;
      }
      if (env.status === "missing") {
        ack?.({ ok: false, error: `git 未安装：${env.detail || "请先在本机/容器安装 git"}` });
        return;
      }
      if (gitJobs.has(g.id)) {
        ack?.({ ok: false, error: "该工作区正在执行 Git 操作，请稍候…" });
        return;
      }
      const dest = gitRepoDir(g.id);
      const cleanUrl = sanitizeGitUrl(url);
      // URL 未内嵌账号时，尝试用当前登录人保存的 git 凭据（仅本次 clone/pull 临时注入，不落盘 .git/config）
      const opUrl = authUrlOf(url, gitCredOf(DATA_DIR, user.account));
      const job = (async () => {
        mkdirSync(gitRepoRoot(), { recursive: true });
        let updated = false;
        if (existsSync(join(dest, ".git"))) {
          // 已有克隆 → 切到新地址并拉取更新
          updated = true;
          const setUrl = await runGit(["-C", dest, "remote", "set-url", "origin", opUrl], { timeoutMs: 30000 });
          if (setUrl.code !== 0) throw new Error("git remote set-url 失败: " + gitErr(setUrl));
          const pull = await runGit(["-C", dest, "pull", "--ff-only"], { timeoutMs: 180000 });
          if (pull.code !== 0) throw new Error("git pull 失败: " + gitErr(pull));
        } else {
          if (existsSync(dest) && readdirSync(dest).length > 0) {
            throw new Error(`目标目录已被占用（非 git 仓库）: ${dest}\n请先处理该目录后再克隆`);
          }
          const cl = await runGit(["clone", "--", opUrl, dest], { timeoutMs: 300000 });
          if (cl.code !== 0) throw new Error("git clone 失败: " + gitErr(cl));
        }
        // 把 remote origin 切回脱敏地址：URL 内嵌的账号/密码或注入凭据不残留 .git/config
        if (cleanUrl !== opUrl) {
          const back = await runGit(["-C", dest, "remote", "set-url", "origin", cleanUrl], { timeoutMs: 30000 });
          if (back.code !== 0) throw new Error("git remote set-url 失败: " + gitErr(back));
        }
        // 仓库级推送凭据 + 提交身份：凭据写入 git 根下 .creds/<gid>（不在工作区），
        // 经 credential.helper 生效——agent 用 run_shell 直接 git push 即可通过认证
        const repoCred = embeddedCredOf(url) || gitCredOf(DATA_DIR, user.account);
        void setupRepoAuth({
          dir: dest,
          url: cleanUrl,
          username: repoCred?.username,
          password: repoCred?.password,
          commitName: user.name,
          commitEmail: `${user.account}@localhost`,
          credFile: gitCredFile(g.id),
        }).catch(() => {}); // 配置失败不阻断克隆（后续仍可手动配）
        const head = await runGit(["-C", dest, "rev-parse", "--short", "HEAD"], { timeoutMs: 15000 });
        const branch = await runGit(["-C", dest, "symbolic-ref", "--short", "HEAD"], { timeoutMs: 15000 });
        const rev = head.code === 0 && head.out.trim() ? `${branch.code === 0 && branch.out.trim() ? branch.out.trim() + "@" : ""}${head.out.trim()}` : "";
        g.workspace = dest;
        g.gitUrl = cleanUrl;
        saveGroups(groups);
        pushGroupsAll();
        io.to(g.id).emit("gitChanged", { groupId: g.id }); // 通知该工作区各端刷新 git 状态
        return { ok: true as const, workspace: dest, gitUrl: cleanUrl, rev, updated };
      })();
      gitJobs.set(g.id, job);
      try {
        const r = await job;
        ack?.({ ...r });
      } catch (e) {
        ack?.({ ok: false, error: (e as Error).message });
      } finally {
        gitJobs.delete(g.id);
      }
    }
  );

  // 查询当前工作区 git 状态（绑定目录/分支/未提交改动/当前登录人凭据），Git 条据此渲染
  socket.on("gitRepoInfo", async (payload: { groupId?: string }, ack?: (r: unknown) => void) => {
    const g = findGroup(payload?.groupId || "");
    const user = socket.data.user as LoginUser | null | undefined;
    if (!g) { ack?.({ ok: false, error: "工作区不存在" }); return; }
    const dir = g.workspace;
    const info = dir ? await repoInfo(dir) : null;
    const cred = user ? gitCredOf(DATA_DIR, user.account) : undefined;
    ack?.({
      ok: true,
      dir: dir || null,
      gitUrl: g.gitUrl || null,
      repo: info,
      cred: cred ? { username: cred.username, has: true } : { username: "", has: false },
      env: gitEnvState(),
    });
  });

  // 当前登录人维护自己的 git 推送凭据（http(s) 用户名 + 密码/访问令牌，首次输入→保存→可改），仅本账号可见。
  // 保存/清除时同步到「当前查看工作区」的克隆仓库：凭据写入仓库级 credential.helper 文件（git 根 .creds/ 下，
  // 不在工作区、不入 .git/config），使 agent 在该仓库 run_shell 直接 git push 时自动通过认证——
  // 提交推送本身由 AI 在会话里完成（提交说明 AI 拟写），无需手动按钮。
  socket.on("saveGitCreds", (payload: { groupId?: string; username?: string; password?: string; clear?: boolean }, ack?: (r: unknown) => void) => {
    const user = socket.data.user as LoginUser | null | undefined;
    if (!user) { ack?.({ ok: false, error: "请先登录（凭据按账号保存）" }); return; }
    const gid = payload?.groupId || socket.data.groupId || "";
    const g = gid ? findGroup(gid) : undefined;
    const dir = g?.workspace && existsSync(join(g.workspace, ".git", "config")) ? g.workspace : undefined;
    try {
      if (payload?.clear) {
        clearGitCred(DATA_DIR, user.account);
        if (dir && g) void clearRepoAuth({ dir, credFile: gitCredFile(g.id) }).catch(() => {});
        ack?.({ ok: true, cleared: true });
        return;
      }
      const username = (payload?.username || "").trim() || user.account;
      const password = (payload?.password || "").trim();
      if (!password) { ack?.({ ok: false, error: "密码/访问令牌不能为空" }); return; }
      const saved = saveGitCred(DATA_DIR, user.account, { username, password });
      if (dir && g) {
        // 同步为当前仓库推送凭据 + 提交身份（同名账号再次保存即覆盖 = "可更改"）
        void setupRepoAuth({
          dir,
          url: g.gitUrl || "",
          username, password,
          commitName: user.name || username,
          commitEmail: `${user.account}@localhost`,
          credFile: gitCredFile(g.id),
        }).catch(() => {});
      }
      ack?.({ ok: true, username: saved.username, synced: !!dir });
    } catch (e) {
      ack?.({ ok: false, error: (e as Error).message });
    }
  });

  // 会话重置：让某成员忘掉之前所有对话（上下文污染/记错的出路，无需重启 server）
  socket.on("resetSession", async (payload: { agentId?: string }, ack?: (r: unknown) => void) => {
    const agent = settings.agents.find((a) => a.id === (payload?.agentId || ""));
    if (!agent) {
      ack?.({ ok: false, error: "成员不存在" });
      return;
    }
    // 枚举该 agent 所有可能 cwd（各工作区绑定的目录 + 自己的沙箱根）→ 逐个清空会话记忆
    const cwds = new Set<string>([join(settings.sandboxDir, agent.id)]);
    for (const g of loadGroups()) if (g.workspace) cwds.add(g.workspace);
    let reset = 0;
    for (const cwd of cwds) {
      reset += resetAgentSession(agent.id, cwd, settings.sandboxDir); // 清空该 (agent,cwd) 的会话记忆（含持久化记录）
    }
    sessionSeeded.clear(); // 会话已重置：下轮重新注入工作区摘要种子
    ack?.({ ok: true, quarantined: reset });
    // 工作区内系统提示（发到发起者当前查看的工作区）
    const gid = socket.data.groupId;
    if (gid && findGroup(gid)) {
      const sys: ChatMsg = {
        id: newId("m"), groupId: gid, senderId: "system", senderName: "系统消息",
        kind: "system", text: `已重置「${agent.shortName}」的会话记忆（清空 ${reset} 份会话）。下次对话将是全新上下文。`,
        ts: Date.now(),
      };
      appendMsg(gid, sys);
      io.to(gid).emit("message", sys);
    }
  });

  // 删工作区：默认工作区保护；磁盘消息/文件保留（可手动找回）；需登录且是工作区成员才能删
  socket.on("deleteGroup", (payload: { groupId?: string }, ack?: (r: unknown) => void) => {
    const user = socket.data.user as LoginUser | null | undefined;
    const id = payload?.groupId || "";
    if (id === "g-dev") {
      ack?.({ ok: false, error: "默认工作区不可删除" });
      return;
    }
    const groups = loadGroups();
    const g = groups.find((x) => x.id === id);
    if (!g) {
      ack?.({ ok: false, error: "工作区不存在" });
      return;
    }
    if (!user || !groupAllowedFor(g, user)) {
      ack?.({ ok: false, code: "NOT_MEMBER", error: "你不是本工作区成员，无法删除该工作区" });
      return;
    }
    saveGroups(groups.filter((x) => x.id !== id));
    const autos = loadAutomations();
    const nextAutos = autos.filter((a) => a.groupId !== id);
    if (nextAutos.length !== autos.length) saveAutomations(nextAutos); // 连带清理本工作区定时任务
    io.socketsLeave(id);
    ack?.({ ok: true });
    pushGroupsAll();
  });

  // 定时任务：建 / 列 / 删（触发时以「⏰ 定时任务」身份发工作区消息并走正常路由）
  socket.on("createAutomation", (payload: { groupId?: string; agentId?: string; everyMin?: unknown; dailyAt?: string; text?: string }, ack?: (r: unknown) => void) => {
    const user = socket.data.user as LoginUser | null | undefined;
    const groupId = payload?.groupId || "";
    const text = (payload?.text || "").trim().slice(0, 500);
    const g0 = findGroup(groupId);
    if (!g0) {
      ack?.({ ok: false, error: "工作区不存在" });
      return;
    }
    if (!user || !groupAllowedFor(g0, user)) {
      ack?.({ ok: false, code: "NOT_MEMBER", error: "你不是本工作区成员，无法创建定时任务" });
      return;
    }
    if (!text) {
      ack?.({ ok: false, error: "任务内容不能为空" });
      return;
    }
    const everyMin = typeof payload?.everyMin === "number" ? Math.floor(payload.everyMin) : undefined;
    const dailyAt = typeof payload?.dailyAt === "string" && /^\d{2}:\d{2}$/.test(payload.dailyAt) ? payload.dailyAt : undefined;
    if ((!everyMin || everyMin < 1 || everyMin > 10080) && !dailyAt) {
      ack?.({ ok: false, error: "周期不合法（每 N 分钟 1~10080，或每天 HH:mm）" });
      return;
    }
    if (everyMin && everyMin < 1) {
      ack?.({ ok: false, error: "周期至少 1 分钟" });
      return;
    }
    let agentId: string | undefined;
    if (payload?.agentId) {
      const g = findGroup(groupId);
      const member = settings.agents.find((a) => a.id === payload.agentId && g?.memberIds.includes(a.id));
      if (!member) {
        ack?.({ ok: false, error: "成员不在本工作区" });
        return;
      }
      agentId = member.id;
    }
    const list = loadAutomations();
    if (list.filter((a) => a.groupId === groupId).length >= 20) {
      ack?.({ ok: false, error: "本工作区定时任务已达上限（20）" });
      return;
    }
    const auto: AutomationDef = {
      id: newId("auto"), groupId, agentId, everyMin, dailyAt, text,
      enabled: true, lastRun: 0, createdAt: Date.now(),
    };
    list.push(auto);
    saveAutomations(list);
    ack?.({ ok: true, automation: auto });
  });

  socket.on("listAutomations", (payload: { groupId?: string }, ack?: (r: unknown) => void) => {
    ack?.({ ok: true, list: loadAutomations().filter((a) => a.groupId === (payload?.groupId || "")) });
  });

  socket.on("deleteAutomation", (payload: { id?: string }, ack?: (r: unknown) => void) => {
    const list = loadAutomations();
    const next = list.filter((a) => a.id !== (payload?.id || ""));
    if (next.length === list.length) {
      ack?.({ ok: false, error: "任务不存在" });
      return;
    }
    saveAutomations(next);
    ack?.({ ok: true });
  });

  // 切换查看的工作区：只更新视角，推送该工作区历史（最近一页）/文件/编排看板；仅成员可进，
  // 非成员/未登录一律不泄露（直接重推其可见工作区列表，客户端自动切走）
  socket.on("joinGroup", (payload: { groupId?: string }) => {
    const groupId = payload?.groupId || "";
    const user = socket.data.user as LoginUser | null | undefined;
    const g = findGroup(groupId);
    if (!g || !groupAllowedFor(g, user)) {
      pushGroupsTo(socket);
      return;
    }
    socket.data.groupId = groupId;
    socket.emit("joinedGroup", { groupId });
    const page = loadHistoryPage(groupId, HISTORY_PAGE);
    socket.emit("history", page.messages);
    socket.emit("historyMeta", { hasMore: page.hasMore });
    socket.emit("files", loadGroupFiles(groupId).slice().reverse());
    // 尾读（从后向前扫，不整文件读入）：编排日志只随 joinGroup 拉最后 400 条
    socket.emit("orchHistory", store.readLinesTail(`orchestrations/${groupId}.jsonl`, 400));
    // 待审批的危险命令：补推给新进的人（审批卡片不落盘，靠这一手保证刷新/晚到也能看到）
    const apr = publicApprovals(groupId);
    if (apr.length) socket.emit("approvals", apr);
  });

  // 翻页：取早于 beforeTs 的上一页历史（升序返回，越接近 beforeTs 越靠后）；仅成员可翻
  socket.on("loadEarlier", (payload: { groupId?: string; beforeTs?: number; limit?: number }, ack?: (r: unknown) => void) => {
    const groupId = payload?.groupId || "";
    const user = socket.data.user as LoginUser | null | undefined;
    const g = findGroup(groupId);
    if (!g) {
      ack?.({ ok: false, error: "工作区不存在" });
      return;
    }
    if (!groupAllowedFor(g, user)) {
      ack?.({ ok: false, code: "NOT_MEMBER", error: "无权查看该工作区历史" });
      return;
    }
    const limit = Math.max(1, Math.min(200, Number(payload?.limit) || HISTORY_PAGE));
    const beforeTs = typeof payload?.beforeTs === "number" ? payload.beforeTs : Infinity;
    const older = store.readLines<ChatMsg>(`messages/${groupId}.jsonl`).filter((m) => m.ts < beforeTs);
    const hasMore = older.length > limit;
    const messages = older.slice(Math.max(0, older.length - limit)); // 取最接近 beforeTs 的一页（升序）
    ack?.({ ok: true, messages, hasMore });
  });

  // 新建工作区：需登录。open=true → 全员真人可见（memberIds 含 human 开放位）；
  // 缺省/关闭 = 私有工作区（创建者 + 被勾选的真人/AI，仅这些人可见）
  socket.on("createGroup", (payload: { name?: string; memberIds?: unknown; open?: unknown }, ack?: (r: unknown) => void) => {
    const user = socket.data.user as LoginUser | null | undefined;
    if (!user) {
      ack?.({ ok: false, code: "NOT_LOGIN", error: "请先登录再创建工作区" });
      return;
    }
    const name = (payload?.name || "").trim().slice(0, 30);
    if (!name) {
      ack?.({ ok: false, error: "工作区名称不能为空" });
      return;
    }
    const valid = memberValidIds();
    let picked: string[];
    if (Array.isArray(payload?.memberIds)) {
      picked = [...new Set((payload!.memberIds as unknown[]).filter((m): m is string => typeof m === "string" && valid.has(m) && m !== "human"))];
    } else {
      picked = settings.agents.map((a) => a.id); // 默认 AI 全员
    }
    if (!picked.some((id) => settings.agents.some((a) => a.id === id))) {
      ack?.({ ok: false, error: "至少选择一名 AI 成员" });
      return;
    }
    const set = new Set(picked);
    if (payload?.open === true) set.add("human");
    else set.add(user.id); // 私有工作区：创建者自动成为成员
    const groups = loadGroups();
    const group: GroupLite = {
      id: newId("g"), name, desc: "",
      memberIds: [...set],
      createdAt: Date.now(),
    };
    groups.push(group);
    saveGroups(groups);
    ack?.({ ok: true, group });
    pushGroupsAll(); // 各端按身份刷新可见工作区列表与房间
  });

  socket.on("send", async (payload: { groupId?: string; text?: string; attachments?: unknown }, ack?: (r: unknown) => void) => {
    // 需要登录：以当前登录真人身份发言（判断"谁在发消息"）
    const user = socket.data.user as LoginUser | null | undefined;
    if (!user) {
      ack?.({ ok: false, code: "NOT_LOGIN", error: "请先登录：输入你的域账号后再发消息（左上角账号栏）" });
      return;
    }
    const text = (payload?.text || "").trim();
    const groupId = payload?.groupId || socket.data.groupId || "";
    const g = findGroup(groupId);
    if (!g) {
      ack?.({ ok: false, error: "工作区不存在" });
      return;
    }
    if (!groupAllowedFor(g, user)) {
      ack?.({ ok: false, code: "NOT_MEMBER", error: "你不在该工作区中，无法发言" });
      return;
    }
    // 附件：上传接口返回的描述数组 {id,name,size,mime,url}
    const attachments: FileAttachment[] = Array.isArray(payload?.attachments)
      ? (payload!.attachments as unknown[])
          .filter((x): x is FileAttachment => !!x && typeof (x as FileAttachment).id === "string" && typeof (x as FileAttachment).name === "string")
          .map((x) => ({ ...(x as FileAttachment) }))
      : [];
    if (!text && attachments.length === 0) return;
    const allImg = attachments.length > 0 && attachments.every((a) => (a.mime || "").startsWith("image/"));
    const human: ChatMsg = {
      id: newId("m"),
      groupId,
      senderId: "human",
      senderName: user.name,
      senderAccount: user.account,
      kind: attachments.length ? (allImg ? "image" : "file") : "text",
      text,
      attachments: attachments.length ? attachments : undefined,
      ts: Date.now(),
    };
    appendMsg(groupId, human);
    io.to(groupId).emit("message", human);
    ack?.({ ok: true, id: human.id, user: { name: user.name, account: user.account } });

    dispatchGroupText(groupId, text, attachments, user);
  });

  // 手动停止：终止工作区内进行中/排队中的 agent 执行（传 agentId 只停该成员；不传停全部含编排）
  socket.on("stopRun", (payload: { groupId?: string; agentId?: string }, ack?: (r: unknown) => void) => {
    const user = socket.data.user as LoginUser | null | undefined;
    if (!user) {
      ack?.({ ok: false, error: "请先登录" });
      return;
    }
    const groupId = payload?.groupId || socket.data.groupId || "";
    const g = findGroup(groupId);
    if (!g) {
      ack?.({ ok: false, error: "工作区不存在" });
      return;
    }
    if (!groupAllowedFor(g, user)) {
      ack?.({ ok: false, error: "你不在该工作区中，无法操作" });
      return;
    }
    const stopped = stopRuns(groupId, payload?.agentId);
    ack?.({ ok: true, stopped });
  });

  // 人工审批：批准/拒绝挂起的危险命令（图会带着决定续跑同一条线程）
  socket.on("resolveApproval", (payload: { groupId?: string; id?: string; approved?: unknown; note?: unknown }, ack?: (r: unknown) => void) => {
    const user = socket.data.user as LoginUser | null | undefined;
    if (!user) { ack?.({ ok: false, error: "请先登录" }); return; }
    const groupId = payload?.groupId || socket.data.groupId || "";
    const g = findGroup(groupId);
    if (!g) { ack?.({ ok: false, error: "工作区不存在" }); return; }
    if (!groupAllowedFor(g, user)) { ack?.({ ok: false, error: "你不在该工作区中，无法操作" }); return; }
    const item = pendingApprovals.get(payload?.id || "");
    if (!item || item.groupId !== groupId) { ack?.({ ok: false, error: "该审批已失效或已被处理" }); return; }
    const approved = payload?.approved === true;
    const note = typeof payload?.note === "string" ? payload.note.trim().slice(0, 200) : "";
    item.resolve({ approved, note });
    ack?.({ ok: true, approved });
  });
});

// ---------- 消息 → agent 分发（send 与定时任务共用） ----------
/** 附件绝对路径注入任务文本（agent 可读取工作区里的上传文件） */
function enrichWithAttachments(groupId: string, text: string, attachments?: FileAttachment[]): string {
  if (!attachments || attachments.length === 0) return text;
  const paths = attachments.map((a) => {
    const abs = join(DATA_DIR, "uploads", groupId, `${a.id}_${a.name}`);
    return `- ${a.name}（${a.size} 字节）：${abs}`;
  }).join("\n");
  return `${text}\n\n—— 工作区内附件文件（如与任务相关，可用读取工具打开）——\n${paths}`;
}
function dispatchGroupText(groupId: string, text: string, attachments?: FileAttachment[], sender?: LoginUser | null) {
  const fullText = enrichWithAttachments(groupId, text, attachments);
  // 交给合适的 agent（一条消息 @ 多人 → 并行执行，各自独立进度流；只路由工作区内成员）
  const agents = routeTasks(groupId, text); // 路由按原文（@ 匹配），执行用带附件路径的全文
  // lead 单独接管（未 @ 或只 @ lead）→ 编排模式：拆解 → 分派 → 汇总
  if (agents.length === 1 && agents[0].role === "lead") {
    void runLeadOrchestration(groupId, agents[0], fullText, sender);
    return;
  }
  for (const agent of agents) {
    void runAgentTask(groupId, agent, fullText, { concurrentCount: agents.length, sender });
  }
}

// ---------- 定时任务（自动化）：到点以「⏰ 定时任务」身份发工作区消息，走正常路由 ----------
interface AutomationDef {
  id: string;
  groupId: string;
  agentId?: string; // 指定成员（消息里 @ 它）；空 = 不 @，走 lead 编排
  everyMin?: number; // 每 N 分钟
  dailyAt?: string; // 每天 HH:mm
  text: string;
  enabled: boolean;
  lastRun: number;
  createdAt: number;
}

function loadAutomations(): AutomationDef[] {
  return store.readJson<AutomationDef[]>("automations.json", []).filter((a) => a && a.id && a.groupId && a.text);
}
function saveAutomations(list: AutomationDef[]) {
  store.writeJson("automations.json", list);
}

/** 触发一个定时任务：发消息进入工作区 → 正常路由 */
function fireAutomation(a: AutomationDef) {
  const agent = a.agentId ? settings.agents.find((x) => x.id === a.agentId) : undefined;
  const mention = agent ? `@${agent.shortName} ` : "";
  const msg: ChatMsg = {
    id: newId("m"),
    groupId: a.groupId,
    senderId: "automation",
    senderName: "⏰ 定时任务",
    kind: "system",
    text: `${mention}${a.text}`,
    ts: Date.now(),
  };
  appendMsg(a.groupId, msg);
  io.to(a.groupId).emit("message", msg);
  console.log(`[automation] ${a.id} 触发 → ${a.groupId}`);
  dispatchGroupText(a.groupId, msg.text);
}

/** 调度器：每 30s tick，检查到期任务（重启后从磁盘恢复，lastRun 持久化防重跑） */
function startAutomationScheduler() {
  const timer = setInterval(() => {
    const list = loadAutomations();
    let dirty = false;
    const now = new Date();
    const nowMs = Date.now();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    for (const a of list) {
      if (!a.enabled) continue;
      let due = false;
      if (a.everyMin && a.everyMin >= 1) {
        due = nowMs - (a.lastRun || 0) >= a.everyMin * 60_000;
      } else if (a.dailyAt && /^\d{2}:\d{2}$/.test(a.dailyAt)) {
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        due = hhmm === a.dailyAt && (a.lastRun || 0) < todayStart; // 今天这个时刻还没跑过
      }
      if (due) {
        a.lastRun = nowMs;
        dirty = true;
        try {
          fireAutomation(a);
        } catch (e) {
          console.error("[automation] 触发失败:", (e as Error).message);
        }
      }
    }
    if (dirty) saveAutomations(list);
  }, 30_000);
  timer.unref?.();
}
startAutomationScheduler();

// ---------- 启动自检：打印 LLM 接入就绪状态（不调用 LLM，纯本地探测）----------
async function printLlmSetup() {
  const llm = settings.llm;
  const keySet = !!llmKeyNow();
  const protocol = llm.protocol || "openai";
  const defaultUrl = protocol === "anthropic" ? "api.anthropic.com" : "api.deepseek.com";
  console.log("  --- LLM 接入（langchain 编排，自包含） ---");
  console.log(`  协议: ${protocol === "anthropic" ? "Anthropic（Claude）" : "OpenAI 兼容（DeepSeek）"}`);
  console.log(`  模型: ${llm.model}`);
  console.log(`  API 地址: ${llm.baseUrl || defaultUrl}${llm.baseUrl ? "" : "（协议默认）"}`);
  console.log(`  API Token: ${keySet ? "已设置 ✓" : "未设置 ✗"}`);
  if (!keySet) {
    console.log("  ⚠ 无 API Token：现在发消息给 agent 会执行失败。在「设置 → LLM 接入」填 API Token（或设 DEEPSEEK_API_KEY）后生效。");
  }
  // 通讯录库就绪状态（真人通讯录/登录校验依赖；首个客户端连接后异步拉全量员工）
  const db = staffDbStatus();
  console.log("  --- 真人通讯录库（uc_staff） ---");
  console.log(`  连接: ${db.host} · 表: ${db.table}`);
  console.log(`  状态: ${db.ready ? "已连接 ✓" : db.error ? `未连接（${db.error}）— 首连接后自动重试` : "未连接 — 首个客户端连接后自动拉取"}`);
}

httpServer.listen(PORT, () => {
  console.log(`agent-hive server: http://127.0.0.1:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  UI: ${UI_DIR}`);
  void printLlmSetup();
  void initRetrievalInBackground(); // 群聊+文件检索索引（后台，不阻塞启动）
  void ensureGitEnv(); // git 环境自举：自检缺失则后台按平台自动安装（就绪/失败经 gitEnv 事件广播）
});

// ---------- 优雅停机：清空会话缓存 ----------
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在清理 agent 会话缓存…`);
  const force = setTimeout(() => process.exit(1), 15_000); // 兜底强退
  force.unref?.();
  try {
    await shutdownHarness();
    console.log("会话缓存已清理，再见");
  } catch (e) {
    console.error("清理会话缓存出错:", (e as Error).message);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
