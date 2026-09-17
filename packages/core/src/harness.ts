// 统一 harness 入口：langchain 编排 agent（替代原 dsh runtime）。
// 一条 run = 构建 chat model + 沙箱工具 + createReactAgent 图，invoke 后提取最终回复与工具事件。
// 上下文管理全部交给 langchain 原生机制：
//   - NodeSqliteSaver（node:sqlite 零依赖实现）+ thread_id 维持会话连续，且落盘 data/agent-sessions.db
//     —— server 重启后记忆不丢（此前 MemorySaver 纯内存态，重启清零靠种子补冷启动）
//   - prompt（stateModifier）里用 trimMessages 裁剪送入 LLM 的消息（按 token 窗口 + startOn=human，
//     天然丢弃开头孤立的 ToolMessage，杜绝"tool 消息失去对应 tool_call"的 API 报错）
//   - run 后用 RemoveMessage 把 state 收敛到上限（防 checkpointer 无限增长）
// 人工审批：run_shell 命中危险命令时工具内调用 interrupt()，图挂起（不抛错），
//   本函数返回 paused + interrupt 载荷；真人批准后由调用方带 resume 再跑一次续上同一条线程。
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { Command } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, RemoveMessage, trimMessages, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { AgentDef, LlmConfig, Settings } from "./types.ts";
import { buildAgentModel, buildSandboxTools } from "./llm.ts";
import { NodeSqliteSaver } from "./sqlite-saver.ts";
import { NodeSqliteStore, memoryDbPath } from "./sqlite-store.ts";
import { guessContextTokens, DEFAULT_CONTEXT_TOKENS } from "./modelContext.ts";

/** LangGraph 工具循环步数上限。默认 25 太小——一轮 = 1 次 LLM 调用 + 工具执行，
 *  写码任务常需"读→写→跑→修"多轮很容易超；设 100 给足余量，失控由 timeoutMs 兜底。 */
const MAX_RECURSION = 100;

/**
 * 上下文窗口不再拍死常量：按模型名自动识别（modelContext.ts）或用户在设置页手动指定。
 * 送入 LLM 的窗口 = 模型窗口 - 输出预留（给回复/工具调用留生成空间），下限 MIN_CONTEXT_WINDOW。
 * token 估算（字符/2）对英文/代码偏保守（实际约 4 字符/token），天然留有安全余量。
 */
/** 输出预留：回复文本 + 工具调用参数的生成空间（不动 state，只影响送入 LLM 的裁剪） */
const OUTPUT_RESERVE_TOKENS = 32_000;
const MIN_CONTEXT_WINDOW = 32_000; // 窗口下限（识别/设置异常时的兜底）

/** state 消息条数上限随窗口缩放：每 4k 窗口保 1 条，钳在 [40, 200]。
 *  窗口大 → state 留更多真实消息（少依赖摘要压缩）；上限 200 防 checkpoint 膨胀。 */
function stateMessageCap(contextWindow: number): number {
  return Math.min(200, Math.max(40, Math.round(contextWindow / 4_000)));
}

/** 每线程保留的历史 checkpoint 数（LangGraph 每 superstep 写一行全量 state，不剪则 O(n²) 膨胀） */
const PRUNE_KEEP = 3;

/** 会话摘要压缩的 LLM 调用超时（防网关挂起卡死串行链） */
const SUMMARY_TIMEOUT_MS = 60_000;

/** 图运行期上下文（langgraph contextSchema）：把 groupId/cwd 从闭包提升为一等运行时上下文，
 *  工具与节点都可在 config.context 里读到，不再依赖构建期捕获。 */
const RUNTIME_CONTEXT = z.object({
  groupId: z.string().optional(),
  cwd: z.string(),
});

// 会话记忆：NodeSqliteSaver 持久化到 data/agent-sessions.db（与沙箱同级，随项目目录走，零外部依赖）。
// thread_id = sessionKey；resetThread 支持按线程删除，resetAgentSession 语义不变。
// 忙碌跟踪：该 (agent,cwd) 是否有任务在跑（供 UI 排队提示）
const busy = new Set<string>();
// 每会话串行链：同 (agent,cwd) 的任务排队执行——防两个 run 并发写同一 thread 的
// checkpointer（状态交错、tool 配对断裂、上下文互相污染）。排队语义此前缺失，
// server 只发了"queued"提示但实际仍是并发执行。
// 注：挂起等待人工审批时该 run 已返回，链随之放行——审批不占用串行位。
const runChains = new Map<string, Promise<unknown>>();

/** 会话库路径：沙箱目录同级（data/agent-sessions.db） */
function sessionDbPath(sandboxDir: string): string {
  return join(dirname(sandboxDir), "agent-sessions.db");
}

// ---- 事件（与原 HarnessSdkEvent 对齐，server 的 progressEv 直接消费）----
export interface HarnessEvent {
  type: string; // tool/call | tool/result | think | delta | approval/request | run/error | timeout ...
  time: number;
  data?: Record<string, unknown>;
}

/** 图挂起时带出的中断载荷（approval 闸门：等待真人批准的命令） */
export interface HarnessInterrupt {
  id?: string;
  value?: unknown;
}

export interface HarnessCallOptions {
  agent: AgentDef;
  settings: Settings;
  task: string;
  sessionId?: string;
  cwd?: string;
  groupId?: string; // 工作区 id：提供时 agent 获得检索工具（search_history / search_workspace / remember / recall）
  timeoutMs?: number;
  onEvent?: (ev: HarnessEvent) => void;
  signal?: AbortSignal; // 外部中止（手动停止按钮）：进行中立即收敛，排队中出队即返回已停止
  resume?: unknown; // 人工审批结果：提供时以 Command({resume}) 续跑上一次挂起的线程（不再追加新任务消息）
  // 结构化输出：提供时图末追加 generate_structured_response 节点（多一次 LLM 调用），
  // 结果落在 HarnessResult.structured。解析失败会自动去掉它重跑一次（见 executeHarnessRun）。
  responseFormat?: AgentResponseFormat;
}

/** createReactAgent 的 responseFormat 类型（zod schema 或 schema + 选项） */
export type AgentResponseFormat = Parameters<typeof createReactAgent>[0]["responseFormat"];

export interface HarnessResult {
  ok: boolean;
  content: string;
  stderr?: string;
  exitCode?: number | null; // langchain 无子进程，恒为 null（兼容旧字段）
  durationMs: number;
  timedOut: boolean;
  aborted?: boolean; // 被外部手动停止（非错误，温和收敛）
  paused?: boolean; // 命中人工审批闸门：图已挂起，等待带 resume 再跑
  interrupt?: HarnessInterrupt;
  structured?: unknown; // responseFormat 的结构化结果（未用则不返回）
  channel: "langchain";
  sessionId?: string;
  error?: string;
  events?: HarnessEvent[];
}

/** sessionId 命名空间 = agent.id + cwd 哈希（同 cwd 连续，换 cwd 即新上下文） */
export function sessionKey(agentId: string, cwd: string): string {
  return `${agentId}-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`;
}

/** 运行时忙碌状态（供 server 排队提示） */
export const runtimeManager = {
  isBusy(agentId: string, cwd: string): boolean {
    return busy.has(sessionKey(agentId, cwd));
  },
};

/** 该 (agent,cwd) 是否已有持久化会话记忆（server 冷启动种子注入的判断依据） */
export function sessionHasHistory(agentId: string, cwd: string, sandboxDir: string): boolean {
  return NodeSqliteSaver.getInstance(sessionDbPath(sandboxDir)).hasThread(sessionKey(agentId, cwd));
}

/** 清空某 (agent,cwd) 的会话记忆（含持久化落盘记录），返回清空的会话数（0/1） */
export function resetAgentSession(agentId: string, cwd: string, sandboxDir: string): number {
  return NodeSqliteSaver.getInstance(sessionDbPath(sandboxDir)).resetThread(sessionKey(agentId, cwd)) ? 1 : 0;
}

/** 关停：清忙碌状态与排队链并关闭数据库句柄。
 *  会话记忆已持久化，不再清空——model 每轮现构建，LLM 配置变更天然对下轮生效，
 *  历史上下文跨配置保留（换模型不丢对话）。 */
export async function shutdownHarness(): Promise<void> {
  busy.clear();
  runChains.clear();
  NodeSqliteSaver.resetInstance();
  NodeSqliteStore.resetInstance();
}

/** 把 langchain 消息 content（string | 内容块数组）抽成纯文本 */
function contentToText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === "string" ? b : (b as { text?: string })?.text ?? ""))
      .join("");
  }
  return c == null ? "" : String(c);
}

/**
 * 是否属于「结构化输出（responseFormat / withStructuredOutput）没取到 tool_call」。
 *
 * 为什么必须枚举真实文案：旧实现只写 `/tool call found/i`，而实际抛的是
 * **`No tool calls found in the response.`**（calls 是复数，中间隔一个 s）——正则永远匹配不上，
 * 于是这条「结构化失败就降级重跑」的保险丝**从来没通过电**，拆解阶段只要模型用正文回答
 * 就把整轮变成（执行失败）气泡抛给真人（实测：@总监 说句"你好"就炸）。
 * 这里把两条真实分支都覆盖：
 *  - 通用实现（BaseChatModel.withStructuredOutput）：`No tool calls found in the response.`
 *  - Anthropic 专用实现（ChatAnthropic 覆盖版）：`No parseable tool calls provided to AnthropicToolsOutputParser.`
 * 判定保持窄匹配，避免把 401 / 超时这类真故障也当成"解析失败"去吞。
 * --- @ty.aicoding@1789472500000 ---
 */
export function isStructuredOutputParseError(msg: string): boolean {
  return /structured response|withStructuredOutput|no parseable tool calls|no tool calls found|tool call found/i.test(msg);
}

/**
 * 粗估 token 计数：字符数 / 2。
 * 中文 ≈ 1 字 1 token、英文 ≈ 4 字符 1 token，取 /2 折中——离线、模型无关，配 32k 窗口余量足够。
 */
async function countTokens(msgs: BaseMessage[]): Promise<number> {
  return Math.ceil(msgs.reduce((s, m) => s + contentToText(m.content).length, 0) / 2);
}

/** trimMessages 统一裁剪参数：按调用方传入的 token 窗口取最后若干条，且必须从 human 消息起头 */
function trimOptions(maxTokens: number) {
  return {
    maxTokens,
    strategy: "last" as const,
    startOn: "human" as const,
    tokenCounter: countTokens,
  };
}

/** 单条消息内容硬截断上限（字符）。防单条超大内容（如 run_shell 的 10 万字符输出）把整个窗口挤空 */
const MAX_MSG_CHARS = 12_000;

/** 内容超长的消息复制并截断（保留 tool_call_id / tool_calls / id 等关键元数据，原消息不动） */
function clipMessage(m: BaseMessage): BaseMessage {
  const text = contentToText(m.content);
  if (text.length <= MAX_MSG_CHARS) return m;
  const type = m.getType();
  const cut = (s: string) => (s.length > MAX_MSG_CHARS ? s.slice(0, MAX_MSG_CHARS) + "\n…[内容过长，已截断]" : s);
  // content 为分片数组时（Anthropic 的 thinking / tool_use 块），**只截断文本块，其余块原样保留**。
  // 早期实现直接把 content 压成字符串重建消息，会丢掉 thinking 与 tool_use——
  // 前者正是网关「thinking 模式必须回传 reasoning_content」报错的来源，后者会打断工具配对。
  // --- @ty.aicoding@1789464711462 ---
  if (Array.isArray(m.content)) {
    const blocks = (m.content as unknown as Array<Record<string, unknown>>).map((b) =>
      typeof b?.text === "string" ? { ...b, text: cut(b.text) } : b
    );
    const am = m as AIMessage;
    if (type === "ai") {
      return new AIMessage({
        content: blocks as never,
        tool_calls: am.tool_calls,
        additional_kwargs: am.additional_kwargs,
        response_metadata: am.response_metadata,
        id: m.id,
      });
    }
    if (type === "tool") {
      const tm = m as ToolMessage;
      return new ToolMessage({ content: blocks as never, tool_call_id: tm.tool_call_id, name: tm.name, id: m.id });
    }
    if (type === "human") return new HumanMessage({ content: blocks as never, id: m.id });
    return m;
  }
  const content = cut(text);
  if (type === "tool") {
    const tm = m as ToolMessage;
    return new ToolMessage({ content, tool_call_id: tm.tool_call_id, name: tm.name, id: m.id });
  }
  if (type === "ai") {
    const am = m as AIMessage;
    return new AIMessage({
      content,
      tool_calls: am.tool_calls,
      additional_kwargs: am.additional_kwargs,
      response_metadata: am.response_metadata,
      id: m.id,
    });
  }
  if (type === "human") return new HumanMessage({ content, id: m.id });
  if (type === "system") return new SystemMessage({ content });
  return m;
}

/** 数组里可能混进非消息项（历史脏 checkpoint、序列化残渣）——这类项一律跳过，别让整个清理抛错 */
function isRealMessage(m: unknown): m is BaseMessage {
  return !!m && typeof (m as BaseMessage).getType === "function";
}

/**
 * 修复悬空的工具配对（自愈）。
 * 模型侧（尤其 Anthropic 协议）硬性要求：带 `tool_calls` 的 assistant 消息后面必须紧跟逐一对应的
 * tool 结果。任务被中断 / checkpoint 修剪 / 审批挂起后 resume 失败时，state 里可能残留
 * 「有 tool_call 没有 tool_result」或「有 tool_result 没有 tool_call」的孤儿消息，
 * 之后该会话的**每一次**请求都会被 400 拒绝（Anthropic：assistant message with 'tool_calls'
 * must be followed by tool messages responding to each 'tool_call_id'），而且不会自愈。
 * 这里在送模型前做一次清理：丢掉孤儿 tool 结果、摘掉没有对应结果的 tool_call（连同一并
 * 剔除 content 里对应的 tool_use 块），消息因此变空壳时整条丢弃。
 * --- @ty.aicoding@1789464711462 ---
 */
function repairToolPairs(messages: BaseMessage[]): BaseMessage[] {
  const msgs = messages.filter(isRealMessage);
  const answered = new Set<string>(); // 已有 tool 结果回应的 tool_call_id
  const declared = new Set<string>(); // assistant 声明过的 tool_call_id
  for (const m of msgs) {
    if (m.getType() === "tool") {
      const id = (m as ToolMessage).tool_call_id;
      if (id) answered.add(id);
    } else if (m.getType() === "ai") {
      for (const tc of (m as AIMessage).tool_calls || []) if (tc.id) declared.add(tc.id);
    }
  }
  const out: BaseMessage[] = [];
  let dropped = 0;
  for (const m of msgs) {
    const type = m.getType();
    if (type === "tool") {
      const id = (m as ToolMessage).tool_call_id;
      if (id && !declared.has(id)) { dropped++; continue; } // 孤儿 tool 结果
      out.push(m);
      continue;
    }
    if (type === "ai") {
      const am = m as AIMessage;
      const tcs = Array.isArray(am.tool_calls) ? am.tool_calls : [];
      const danglingIds = new Set(tcs.filter((tc) => tc.id && !answered.has(tc.id)).map((tc) => tc.id as string));
      if (danglingIds.size === 0) { out.push(m); continue; }
      const keep = tcs.filter((tc) => !tc.id || !danglingIds.has(tc.id));
      let content = am.content;
      if (Array.isArray(content)) {
        content = (content as unknown as Array<{ type?: string; id?: string }>)
          .filter((b) => !(b?.type === "tool_use" && b.id && danglingIds.has(b.id))) as never;
      }
      if (keep.length === 0 && !contentToText(content).trim()) { dropped++; continue; } // 空壳
      out.push(
        new AIMessage({
          content,
          ...(keep.length ? { tool_calls: keep } : {}),
          additional_kwargs: am.additional_kwargs,
          response_metadata: am.response_metadata,
          id: m.id,
        })
      );
      continue;
    }
    out.push(m);
  }
  if (dropped) console.warn(`[harness] 修复悬空工具配对：丢弃 ${dropped} 条孤儿消息（防 400 死锁）`);
  return out;
}

/**
 * 悬空配对的 assistant 消息 id 集合（带 tool_calls 但其结果缺失）。
 * 用于失败回滚时把这些消息**整条移除**——只删本轮新消息不够：见 rollbackRun 里的说明。
 * --- @ty.aicoding@1789464711462 ---
 */
function danglingAiMsgIds(messages: BaseMessage[]): Set<string> {
  const msgs = messages.filter(isRealMessage);
  const answered = new Set<string>();
  for (const m of msgs) {
    if (m.getType() === "tool") {
      const id = (m as ToolMessage).tool_call_id;
      if (id) answered.add(id);
    }
  }
  const out = new Set<string>();
  for (const m of msgs) {
    if (m.getType() !== "ai" || !m.id) continue;
    const tcs = (m as AIMessage).tool_calls || [];
    if (tcs.some((tc) => tc.id && !answered.has(tc.id))) out.add(m.id);
  }
  return out;
}

/**
 * 统一上下文裁剪：先修悬空工具配对 → 再按单条截断（防超大输出挤空窗口）→ 再按 token 窗口裁剪 → 再修一次。
 * 兜底：若裁剪结果为空（理论已不可达），从最近一条 human 消息起保留到结尾（角色/配对安全）。
 */
async function trimForContext(messages: BaseMessage[], maxTokens: number): Promise<BaseMessage[]> {
  const clipped = repairToolPairs(messages.map(clipMessage));
  const trimmed = await trimMessages(clipped, trimOptions(maxTokens));
  if (trimmed.length > 0) return repairToolPairs(trimmed);
  let i = clipped.length - 1;
  while (i > 0 && clipped[i].getType() !== "human") i--;
  return repairToolPairs(clipped.slice(i));
}

/**
 * 流式消费：把本轮新增消息实时转成事件（think / tool/call / tool/result），
 * 每完成一个图节点（agent 推理 / tools 执行）就发一批——UI 得以流式展示思考过程。
 */
function emitLiveMessages(messages: BaseMessage[], ev: (type: string, data?: Record<string, unknown>) => void) {
  for (const m of messages) {
    const type = m.getType();
    if (type === "ai") {
      // AI 的中间文本（调工具前的自言自语）→ think 事件
      const text = contentToText(m.content).trim();
      if (text) ev("think", { text: text.slice(0, 400) });
      const toolCalls = (m as unknown as { tool_calls?: Array<{ name?: string; args?: unknown; id?: string }> }).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (!tc?.name) continue;
          ev("tool/call", { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) });
        }
      }
    } else if (type === "tool") {
      ev("tool/result", {
        message: { content: contentToText(m.content).slice(0, 2000), isError: false },
        ok: true,
      });
    }
  }
}

/**
 * 流式增量：messages 模式的载荷是 [AIMessageChunk, metadata]，
 * 只取正文增量（工具调用增量不进正文），转成 delta 事件供 UI 逐字渲染。
 * --- @ty.aicoding@1789442083508 ---
 */
function emitDelta(payload: unknown, ev: (type: string, data?: Record<string, unknown>) => void) {
  const msg = Array.isArray(payload) ? payload[0] : payload;
  if (!msg || typeof msg !== "object") return;
  const m = msg as { getType?: () => string; content?: unknown; tool_call_chunks?: unknown[] };
  if (typeof m.getType !== "function" || m.getType() !== "ai") return;
  if (Array.isArray(m.tool_call_chunks) && m.tool_call_chunks.length > 0) return;
  const text = contentToText(m.content);
  if (text) ev("delta", { text: text.slice(0, 4000) });
}

/**
 * 会话摘要压缩：把"早期摘要 + 本轮被移出 state 的消息段"合并成新摘要（≤2000 字符）。
 * 保留：任务目标、关键决策、重要结果/数据、文件路径、命名约定。工具结果只留关键结论。
 */
async function buildSessionSummary(
  model: ReturnType<typeof buildAgentModel>,
  prevSummary: string | null,
  removed: BaseMessage[]
): Promise<string> {
  const segment = removed
    .map((m) => {
      const t = m.getType();
      const text = contentToText(m.content).trim();
      if (!text) return "";
      if (t === "human") return `[用户] ${text}`;
      if (t === "ai") return `[助手] ${text}`;
      if (t === "tool") return `[工具结果] ${text.slice(0, 300)}`; // 工具输出只留头部（结论通常在开头）
      return `[${t}] ${text.slice(0, 300)}`;
    })
    .filter(Boolean)
    .join("\n");
  if (!segment) return prevSummary ?? "";
  const prompt = `你是会话备忘压缩器。请把【早期摘要】与【新近被移出上下文的对话段】合并为一份新摘要，供后续任务作为既定背景使用。
要求：≤1200 字符；保留任务目标、关键决策、重要结果与数据、文件路径、命名约定；工具结果只保留关键结论；按主题归类，输出摘要正文本身（无前言无结尾）。

【早期摘要】
${prevSummary ?? "（无）"}

【新近对话段】
${segment.slice(0, 24_000)}`;
  const res = await model.invoke([new HumanMessage(prompt)]);
  const text = contentToText((res as { content?: unknown }).content).trim();
  return text ? text.slice(0, 2_000) : (prevSummary ?? "");
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<{ value?: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then((value) => ({ value, timedOut: false })),
      new Promise<{ value?: T; timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runHarness(opts: HarnessCallOptions): Promise<HarnessResult> {
  const { agent, settings } = opts;
  const cwd = opts.cwd ?? join(settings.sandboxDir, agent.id);
  mkdirSync(cwd, { recursive: true });
  const key = sessionKey(agent.id, cwd);

  // 同会话串行：排队等上一条跑完（上一条失败不阻塞），防止并发写同一 thread 的 checkpointer。
  // 排队中的任务出队时才构建 model/agent，配置变更（shutdownHarness 清链）对排队任务同样生效。
  const prev = runChains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => executeHarnessRun(opts, key, cwd));
  runChains.set(key, run);
  return run;
}

/**
 * 单次执行体（在同一 (agent,cwd) 的排队链里串行执行）：
 * 构建 chat model + 沙箱/检索/联网工具 + React 图，流式跑完并收敛上下文后返回结果。
 * opts.resume 有值时走"续跑"分支：以 Command({resume}) 接上被 interrupt 挂起的线程。
 * responseFormat 解析失败会自动去掉它重跑一次（structuredRetried=true 防递归）。
 * --- @ty.aicoding@1789442083508 ---
 */
async function executeHarnessRun(opts: HarnessCallOptions, key: string, cwd: string, structuredRetried = false): Promise<HarnessResult> {
  const { agent, settings, task } = opts;
  const start = Date.now();

  const events: HarnessEvent[] = [];
  const ev = (type: string, data?: Record<string, unknown>) => {
    const e: HarnessEvent = { type, time: Date.now(), data };
    events.push(e);
    opts.onEvent?.(e);
  };
  // 高频增量（delta）：只透传给调用方实时渲染，不进 events 数组（防长回复把事件列表撑爆）
  const tick = (type: string, data?: Record<string, unknown>) => {
    opts.onEvent?.({ type, time: Date.now(), data });
  };

  // 角色级 llm 覆盖 > 全局
  const llm: LlmConfig = {
    protocol: agent.llm?.protocol || settings.llm.protocol || "openai",
    baseUrl: agent.llm?.baseUrl || settings.llm.baseUrl,
    model: agent.llm?.model || settings.llm.model,
    apiKey: agent.llm?.apiKey || settings.llm.apiKey,
    apiKeyEnv: agent.llm?.apiKeyEnv || settings.llm.apiKeyEnv,
    fallback: agent.llm?.fallback || settings.llm.fallback,
  };

  // 上下文窗口解析（优先级）：角色显式设置 > 全局设置（角色没换模型时才适用）> 按模型名识别 > 默认。
  // 角色覆盖了模型但没覆盖窗口 → 不套用全局窗口（那是给全局模型设的），按角色自己的模型重新识别。
  const agentOverridesModel = !!agent.llm?.model && agent.llm.model !== settings.llm.model;
  const modelContextTokens =
    agent.llm?.contextTokens ??
    (agentOverridesModel ? undefined : settings.llm.contextTokens) ??
    guessContextTokens(llm.model) ??
    DEFAULT_CONTEXT_TOKENS;
  const contextWindow = Math.max(modelContextTokens - OUTPUT_RESERVE_TOKENS, MIN_CONTEXT_WINDOW); // 送 LLM 的实际窗口
  const stateCap = stateMessageCap(contextWindow);

  busy.add(key);
  try {
    // buildAgentModel：恒返回 ResilientChatModel 包装（未配备用模型时只保留"网关抖动原样重试"，见 llm.ts）
    const model = buildAgentModel(llm);
    // 长期记忆（BaseStore）：工作区作用域，跨会话重置与跨工作区隔离（data/agent-memory.db）
    const store = NodeSqliteStore.getInstance(memoryDbPath(dirname(settings.sandboxDir)));
    // 检索索引与 agent-sessions.db 同级（data/ 根）：sandboxDir 的父目录；
    // allowed=角色工具白名单（lead 只读等，见 AgentDef.tools）
    const tools = buildSandboxTools(cwd, {
      groupId: opts.groupId,
      dataDir: dirname(settings.sandboxDir),
      allowed: opts.agent.tools,
      web: settings.web, // 联网配置（总开关/provider）由页面「设置 → 联网」写入
      approval: settings.approval, // 危险命令审批闸门（run_shell）
      store,
    });
    // 会话级 checkpointer（thread_id = sessionKey）：同一 (agent,cwd) 的历史由 langgraph 自动读写，
    // 落盘 data/agent-sessions.db（node:sqlite 零依赖，跨 server 重启持久）
    const saver = NodeSqliteSaver.getInstance(sessionDbPath(settings.sandboxDir));
    const config = { configurable: { thread_id: key }, context: { groupId: opts.groupId, cwd } };

    // 早期摘要：被挤出上下文窗口的内容由 LLM 压缩成备忘（收敛时生成），作为既定背景注入——
    // 没有它，长会话里最早的任务目标/关键决策会随窗口滑动作废，agent"忘了初心"
    const earlySummary = saver.getSummary(key);
    const summaryBlock = earlySummary ? `\n\n## 早期会话摘要（已被压缩的更早内容，视为既定背景，无需重复确认）\n${earlySummary}` : "";

    const rules = agent.rules?.length ? `\n工作规则：\n${agent.rules.map((r) => `- ${r}`).join("\n")}` : "";
    const retrievalHint = opts.groupId
      ? `\n你还有本地检索能力：search_history 搜群聊全部历史（含你记忆之外的更早讨论，记不清就搜），search_workspace 按内容找文件。`
      : "";
    const memoryHint = tools.some((t) => t.name === "recall")
      ? `\n工作区有一份共享长期记忆（团队共同维护、跨会话保留）：动手前先 recall 查一下既有约定/口径，形成结论后把值得长期保留的事实用 remember 记下来。`
      : "";
    // 联网能力提示：只在工具真的注册了才提（关掉时不诱导模型去"上网"）
    const webHint = tools.some((t) => t.name === "web_search")
      ? `\n你有联网能力：web_search 搜网页、web_fetch 读某个网址的正文。遇到不熟的库/API/报错或需要外部资料时主动联网查证，不要凭记忆猜。`
      : tools.some((t) => t.name === "web_fetch")
        ? `\n你有联网能力：web_fetch 可读取已知网址的正文（搜索后端已关闭）。`
        : "";
    // 审批闸门提示：让模型知道高危命令会暂停、以及为什么必须单独调用（恢复会重跑同批工具）
    const approvalHint = tools.some((t) => t.name === "run_shell") && settings.approval?.enabled !== false
      ? `\n高危命令（删除文件、git push、提权、读取凭据、访问工作区外路径等）不会直接执行，而是挂起等待真人批准。这类命令务必单独调用一次，不要和其它工具放在同一批（审批恢复会重跑同一批工具）。`
      : "";
    const toolNames = tools.map((t) => t.name).join(" / ");
    // systemPrompt 按「稳定前缀 → 易变后缀」排序（蹭 provider 的 prompt 前缀缓存，
    // 参考 Claude forked agent 模式 92% 缓存复用）：工具行与角色设定稳定在前，
    // 早期摘要随会话演进放最后——同会话多轮/同角色跨会话能命中更长的缓存前缀。
    const systemPrompt = `你的工作区就是当前目录，用提供的工具（${toolNames}）在目录内完成操作。一次只处理当前这条消息的任务；历史里若有未完成的旧任务，除非本条消息明确要求继续，否则不要主动接着做。完成后用简洁中文汇报做了什么、结果如何；若产出文件给出相对路径。\n` +
      `背景：你是${agent.title}（${agent.name}）。${agent.persona}${rules}${retrievalHint}${memoryHint}${webHint}${approvalHint}${summaryBlock}`;

    const agentInstance = createReactAgent({
      llm: model,
      tools,
      checkpointer: saver,
      store, // 跨线程长期记忆（工具直接读写同一实例）
      contextSchema: RUNTIME_CONTEXT, // 运行期上下文（groupId/cwd）由 config.context 传入
      ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}),
      // 每次调用 LLM 前：单条截断 + token 窗口裁剪（窗口按模型解析：识别/手动设置 - 输出预留），再拼 system prompt（历史里不存 system，每次现拼）
      prompt: async (state: { messages: BaseMessage[] }) => {
        const trimmed = await trimForContext(state.messages, contextWindow);
        return [new SystemMessage(systemPrompt), ...trimmed];
      },
    });

    const timeoutMs = opts.timeoutMs ?? 600_000;
    const signal = opts.signal;
    // 手动停止 → 温和收敛（非错误）：排队中出队即停 / 进行中打断 LLM 与图循环
    const abortedResult = (error = "已手动停止"): HarnessResult => ({
      ok: false, content: "", channel: "langchain", sessionId: key, events,
      durationMs: Date.now() - start, timedOut: false, aborted: true, error,
    });
    if (signal?.aborted) return abortedResult();
    // 运行前基线：本条任务起跑前 state 里已有的消息 id 集。
    // 失败 / 超时 / 手动停止 → 把本轮新增的消息全部从 state 移除（回滚到起跑前）：
    // 半途而废的过程若留在上下文，下一轮会"继续旧任务 + 干新任务"叠着跑，
    // 反复撞 recursionLimit（100 步），且观感上像同一成员并发处理多条消息。
    const beforeIds = new Set(
      (((await agentInstance.getState(config)).values as { messages?: BaseMessage[] } | undefined)?.messages ?? [])
        .map((m) => m.id)
        .filter((id): id is string => !!id)
    );
    const rollbackRun = async () => {
      try {
        const cur = (((await agentInstance.getState(config)).values as { messages?: BaseMessage[] } | undefined)?.messages) ?? [];
        const removals = cur.filter((m) => m.id && !beforeIds.has(m.id)).map((m) => new RemoveMessage({ id: m.id as string }));
        // 只删「本轮新增」不够：审批闸门挂起后 resume 的那一轮如果失败，本轮刚写入的 tool 结果会被删掉，
        // 而它回应的 assistant tool_call 属于**上一轮**（在 beforeIds 里，不在删除范围内）——于是留下
        // 悬空配对，该线程之后每一次请求都会被 Anthropic 侧 400 拒绝且永不自愈（实测踩到）。
        // 这里把这类悬空 assistant 消息一并移除，从源头保持配对完整。
        const kept = cur.filter((m) => !(m.id && !beforeIds.has(m.id)));
        const dangling = danglingAiMsgIds(kept);
        for (const id of dangling) removals.push(new RemoveMessage({ id }));
        if (removals.length) await agentInstance.updateState(config, { messages: removals });
        if (dangling.size) console.warn(`[harness] 回滚时清理 ${dangling.size} 条悬空 tool 配对消息`);
      } catch (e) {
        // 回滚失败不影响错误返回（下轮沿用带残迹的上下文，只是不够干净；送模型前还有 repairToolPairs 兜底）
        console.warn("[harness] 失败回滚清理失败:", (e as Error).stack || (e as Error).message);
      }
    };
    /**
     * 捞回本轮已产出的正文（最后一条有正文的 ai 消息）。
     * 专门用于"失败发生在收尾节点（结构化输出）"的场景：正文其实已经产出并流式展示给真人了，
     * 不该因为收尾节点失败就把整轮判死。读不到（或压根没正文）返回空串，调用方再走重跑/报错。
     * --- @ty.aicoding@1789472500000 ---
     */
    const salvageLastReply = async (): Promise<string> => {
      try {
        const cur = (((await agentInstance.getState(config)).values as { messages?: BaseMessage[] } | undefined)?.messages) ?? [];
        for (let i = cur.length - 1; i >= 0; i--) {
          const m = cur[i];
          if (!m || typeof m.getType !== "function" || m.getType() !== "ai") continue;
          const t = contentToText(m.content).trim();
          if (t) return t;
        }
      } catch (err) {
        console.warn("[harness] 捞回已产出正文失败:", (err as Error)?.message);
      }
      return "";
    };
    // 图输入：续跑走 Command({resume})（接上上次挂起的线程，不再注入任务消息）；否则是本轮任务消息
    const input = opts.resume !== undefined
      ? new Command({ resume: opts.resume })
      : { messages: [new HumanMessage(task)] };
    // 流式执行（updates + messages 双模式）：
    //   updates —— 每完成一个图节点吐一次增量消息 → think / tool 事件（UI 思考过程）
    //   messages —— token 级增量 AIMessageChunk → delta 事件（UI 逐字打字机）
    try {
      const { timedOut } = await withTimeout(
        (async () => {
          // 多模式流式（updates + messages）：langgraph 的联合模式让 TS 推出 never，这里按裸迭代器消费
          const stream = (await agentInstance.stream(input as never, {
            ...config,
            recursionLimit: MAX_RECURSION,
            streamMode: ["updates", "messages"],
            signal,
          } as never)) as unknown as AsyncIterable<unknown>;
          for await (const chunk of stream) {
            if (signal?.aborted) break; // 手动停止：不再消费后续节点
            if (!chunk) continue;
            // 多模式流每项是 [mode, payload]；单模式时是裸 payload（兼容处理）
            const tuple = Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string"
              ? (chunk as [string, unknown])
              : undefined;
            const mode = tuple ? tuple[0] : "updates";
            const payload = tuple ? tuple[1] : chunk;
            if (mode === "messages") {
              emitDelta(payload, tick);
              continue;
            }
            if (!payload || typeof payload !== "object") continue;
            for (const update of Object.values(payload as Record<string, unknown>)) {
              const msgs = (update as { messages?: BaseMessage[] } | undefined)?.messages;
              if (Array.isArray(msgs) && msgs.length) emitLiveMessages(msgs, ev);
            }
          }
        })(),
        timeoutMs
      );
      if (signal?.aborted) {
        ev("aborted", {});
        await rollbackRun(); // 停止残迹（含悬空 tool_calls 配对）不留给下一轮
        return abortedResult();
      }
      if (timedOut) {
        ev("timeout", { timeoutMs });
        await rollbackRun(); // 超时半成品回滚，下一轮从干净基线开始
        return {
          ok: false, content: "", channel: "langchain", sessionId: key, events,
          durationMs: Date.now() - start, timedOut: true, error: `执行超时（${timeoutMs}ms）`,
        };
      }
      // 人工审批闸门：图被 interrupt() 挂起时 stream 正常结束（顶层图会抑制 GraphInterrupt 抛出），
      // 挂起信息留在 state.tasks[].interrupts —— 此时绝不能回滚/修剪（checkpoint 就是恢复的唯一依据）
      const snap = await agentInstance.getState(config);
      const pending: HarnessInterrupt[] = ((snap.tasks ?? []) as Array<{ interrupts?: HarnessInterrupt[] }>)
        .flatMap((t) => t.interrupts ?? []);
      if (pending.length > 0) {
        const interrupt: HarnessInterrupt = { id: pending[0].id, value: pending[0].value };
        ev("approval/request", { interrupt });
        return {
          ok: true, content: "", paused: true, interrupt, channel: "langchain", sessionId: key, events,
          durationMs: Date.now() - start, timedOut: false,
        };
      }
    } catch (e) {
      // LLM 请求被 abort / 图执行中止 → 收敛为"已停止"，不按错误冒泡
      if (signal?.aborted || (e as Error)?.name === "AbortError") {
        ev("aborted", {});
        await rollbackRun();
        return abortedResult();
      }
      const raw = (e as Error)?.message || String(e);
      // 结构化输出没取到函数调用（见 isStructuredOutputParseError 的说明）：图里的 agent 节点其实已经产出、
      // 并且**已经流式推给前端**了正文。整轮当失败打回，真人只会看到一个红色「执行失败」气泡、正文白说。
      // 所以优先把已产出的正文捞回来当本轮结果——**不回滚**：那段正文就是这一轮的真实对话，
      // 回滚会让「界面看到的」与「上下文记住的」不一致（旧实现正是回滚后才判断，等于把正文也删了）。
      if (opts.responseFormat && isStructuredOutputParseError(raw)) {
        const salvaged = await salvageLastReply();
        if (salvaged) {
          ev("structured/fallback", { message: `结构化输出未取到函数调用（${raw.slice(0, 120)}），已退回正文结果` });
          try { saver.pruneThread(key, PRUNE_KEEP); } catch { /* 修剪失败不影响任务结果 */ }
          return {
            ok: true, content: salvaged, channel: "langchain", sessionId: key, events,
            durationMs: Date.now() - start, timedOut: false,
          };
        }
        if (!structuredRetried) {
          await rollbackRun(); // 连正文都没有 → 本轮确是残迹，回滚后再摘掉 schema 重跑一次
          ev("structured/fallback", { message: `结构化输出解析失败且无正文可退回，已摘掉 schema 重跑：${raw.slice(0, 160)}` });
          return executeHarnessRun({ ...opts, responseFormat: undefined }, key, cwd, true);
        }
      }
      await rollbackRun(); // recursionLimit / LLM 报错等：本轮残迹回滚，防下轮叠任务再撞上限
      throw e;
    }

    // 流跑完后从 checkpointer 读最终全量消息（state 的权威视图）
    const finalState = await agentInstance.getState(config);
    const messages: BaseMessage[] =
      ((finalState.values as { messages?: BaseMessage[] } | undefined)?.messages) ?? [];
    const structured = (finalState.values as { structuredResponse?: unknown } | undefined)?.structuredResponse;

    // state 收敛：超出条数上限时用 RemoveMessage 移除最旧消息（保留集与 LLM 裁剪同一套配对安全逻辑）
    // 上限随上下文窗口缩放（stateMessageCap）：大窗口多留真实消息，少依赖摘要压缩
    let removedFromState: BaseMessage[] = [];
    if (messages.length > stateCap) {
      const keep = await trimForContext(messages, contextWindow);
      const keepIds = new Set(keep.map((m) => m.id).filter((id): id is string => !!id));
      removedFromState = messages.filter((m) => m.id && !keepIds.has(m.id));
      const removals = removedFromState.map((m) => new RemoveMessage({ id: m.id as string }));
      if (removals.length) await agentInstance.updateState(config, { messages: removals });
    }

    // 摘要压缩：被永久移出 state 的内容用 LLM 压成备忘存库，下轮注入 systemPrompt——
    // 防长会话窗口滑动把早期任务目标/关键决策挤丢。失败/超时均不影响任务结果（下次收敛还会再压）。
    if (removedFromState.length) {
      try {
        const { value: merged } = await withTimeout(
          buildSessionSummary(model, saver.getSummary(key), removedFromState),
          SUMMARY_TIMEOUT_MS
        );
        if (merged) saver.setSummary(key, merged);
      } catch (e) {
        console.warn("[harness] 会话摘要压缩失败:", (e as Error).message);
      }
    }

    // 提取最终回复（事件已在流式过程中实时发出）
    let content = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].getType() === "ai") {
        const t = contentToText(messages[i].content).trim();
        if (t) { content = t; break; }
      }
    }

    // 修剪历史 checkpoint（每 superstep 一行、行含全量消息 → 不剪则 O(n²) 膨胀）。
    // 只留最近 PRUNE_KEEP 个；本应用不用 time-travel，仅读最新状态，旧 checkpoint 可安全清除。
    try {
      saver.pruneThread(key, PRUNE_KEEP);
    } catch (e) {
      // 修剪失败不影响任务结果（下次运行还会再剪）
      console.warn("[harness] checkpoint 修剪失败:", (e as Error).message);
    }

    return {
      ok: true, content, structured, channel: "langchain", sessionId: key, events,
      durationMs: Date.now() - start, timedOut: false,
    };
  } catch (e) {
    const err = e as Error;
    const raw = err?.message || String(e);
    // 撞 LangGraph 循环上限：转成可操作的中文提示（原始报错是英文且不带解决建议）
    const msg = /recursion limit/i.test(raw)
      ? `任务超出工具循环上限（${MAX_RECURSION} 步）。任务可能过于复杂，建议拆成更小的步骤让成员分步执行。`
      : raw;
    ev("run/error", { message: msg });
    return {
      ok: false, content: "", channel: "langchain", sessionId: key, events,
      durationMs: Date.now() - start,
      timedOut: /timeout|timed out/i.test(msg),
      error: msg,
    };
  } finally {
    busy.delete(key);
  }
}
