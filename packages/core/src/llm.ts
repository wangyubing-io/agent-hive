// LLM 客户端工厂 + 沙箱工具定义（langchain 编排核心）。
// 支持两种协议：openai（OpenAI 兼容，含 DeepSeek）与 anthropic（Claude / DeepSeek anthropic 端点）。
// 工具用 @langchain/core/tools 的 tool() 包装，供 createReactAgent 编排使用。
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { Runnable } from "@langchain/core/runnables";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import type { ApprovalConfig, LlmConfig, WebConfig } from "./types.ts";
import { sandboxReadFile, sandboxWriteFile, sandboxListDir, sandboxRunShell } from "./sandbox.ts";
import { getRetrieval, formatChatHits, formatFileHits } from "./retrieval.ts";
import { webFetch as doWebFetch, webSearch as doWebSearch, DEFAULT_SEARCH_PROVIDER } from "./web.ts";
import { detectDangerousCommand } from "./approval.ts";
import type { NodeSqliteStore } from "./sqlite-store.ts";

/** 协议默认地址（未填 baseUrl 时） */
const DEFAULT_BASE_URL = {
  openai: "https://api.deepseek.com",
  anthropic: "https://api.anthropic.com",
} as const;

/** 解析 API key：cfg.apiKey > cfg.apiKeyEnv 指定 env > 协议默认 env > 兜底 */
function resolveApiKey(cfg: LlmConfig): string {
  if (cfg.apiKey) return cfg.apiKey;
  const protocol = cfg.protocol || "openai";
  const envName = cfg.apiKeyEnv || (protocol === "anthropic" ? "ANTHROPIC_API_KEY" : "DEEPSEEK_API_KEY");
  return process.env[envName] || process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || "";
}

function resolveBaseUrl(cfg: LlmConfig): string {
  if (cfg.baseUrl) return cfg.baseUrl;
  return cfg.protocol === "anthropic" ? DEFAULT_BASE_URL.anthropic : DEFAULT_BASE_URL.openai;
}

/** 按配置构建 chat model（进程内 HTTP 直连，无子进程冷启动） */
export function buildChatModel(cfg: LlmConfig) {
  const apiKey = resolveApiKey(cfg);
  const baseUrl = resolveBaseUrl(cfg);
  if ((cfg.protocol || "openai") === "anthropic") {
    return new ChatAnthropic({
      model: cfg.model,
      apiKey,
      clientOptions: { baseURL: baseUrl },
    });
  }
  return new ChatOpenAI({
    model: cfg.model,
    apiKey,
    configuration: { baseURL: baseUrl },
  });
}

/** 内部链节点：可能是 chat model 本身，也可能是 bindTools 之后的 RunnableBinding */
type ModelRunnable = Runnable<unknown, BaseMessage>;

/** 去掉 langchain 消息 content 的复杂结构，取纯文本（usage 统计不需要） */
function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : ((b as { text?: string })?.text ?? ""))).join("");
  }
  return content == null ? "" : String(content);
}

/** 把模型返回的消息统一转成 AIMessageChunk（已是 chunk 则原样返回） */
function asChunk(m: BaseMessage): AIMessageChunk {
  if (AIMessageChunk.isInstance(m)) return m;
  const ai = m as AIMessage;
  return new AIMessageChunk({
    content: ai.content,
    tool_calls: ai.tool_calls,
    id: ai.id,
    name: ai.name,
    additional_kwargs: ai.additional_kwargs,
    response_metadata: ai.response_metadata,
    usage_metadata: ai.usage_metadata,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 网关抖动重试参数（环境变量可覆盖，主要给离线测试用极小退避跑满重试上限）。
 *
 * 为什么总尝试次数是 8：2026-09-15 两组定量实验。
 * 【实验一：这是"时间性故障窗口"，不是我们改出来的】
 *   同一份真实载荷（21 条消息 / 131KB，含 24 个无签名 thinking 块）交错对比
 *   "原样"与"剥掉全部 thinking（131KB→115KB）"各 3 轮 → 都是 2/3，**无差别**；
 *   再拿 9/9 当年**跑通过**的 1KB 老载荷（零 thinking、5 条消息）今天重放 → 只有 3/6；
 *   模型换成 flash 对比 pro → 无显著差别。
 *   → 请求体（内容/长短/模型）都不是变量；同一份请求过去成功现在失败，
 *     说明是网关侧行为变化，且**成败成簇出现、好坏窗口可持续数分钟**。
 * 【实验二：8 次是否够用】
 *   在采样区间内单次调用成功率 83%：100 次成功共 121 次调用，尝试次数分布
 *   1 次→85、2 次→10、3 次→4、4 次→1，**最长 4 次**、P90=2、0 例超过 8 次。
 *   按最坏的 50% 窗口估算，8 次全败概率 0.5^8 ≈ 0.4%，留有余量。
 *   （上一轮在坏窗口里测到的分布是「允许 1 次→5/10、3 次→7/10、8 次→10/10」，
 *     两组差异本身就印证了"窗口"这个变量。）
 * 退避取几何增长（0.4/0.8/1.6/3.2/4/4/4s，累计约 18s）；首次退避仍保持很短，
 * 让"只抖一次"的常见情形几乎无感。
 */
function retryTuning() {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    attempts: Math.max(1, Math.round(num(process.env.AGENT_HIVE_GW_RETRY_ATTEMPTS, 8))),
    baseMs: num(process.env.AGENT_HIVE_GW_RETRY_BACKOFF_MS, 400),
    maxMs: num(process.env.AGENT_HIVE_GW_RETRY_BACKOFF_MAX_MS, 4000),
  };
}

/** 第 attempt 次尝试失败后的等待时长：几何增长 + 上限 + 少量抖动（防多成员同时重试撞在一起） */
function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const grow = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(grow * (0.85 + Math.random() * 0.3));
}

/**
 * 重试用尽后的错误包装：在**保留网关原文**的前提下加一句人话提示。
 * 真人看到 `（执行失败）400 {"error":...}` 是看不懂的，而这类失败直接重发消息就能过，
 * 所以必须把"这不是你的操作问题、重发即可"讲清楚（原文留在后面，便于排查）。
 * 只在**真的重试过**（tries > 1）时加提示——"已吐增量所以不重试"那条路只发过一次请求，
 * 说"连续 N 次被拒"是假话。
 * --- @ty.aicoding@1789470019630 ---
 */
function exhaustedFlakeError(lastErr: unknown, tries: number): unknown {
  if (tries <= 1 || !isGatewayFlake(lastErr)) return lastErr;
  const raw = (lastErr as Error)?.message || String(lastErr);
  return new Error(`网关连续 ${tries} 次以 thinking 模式 400 拒绝同一请求（网关侧非确定行为，与本项目无关；把这条消息重发一次通常就能过）：${raw}`);
}

/**
 * 是否属于「网关抖动」类失败：同一次请求重发即可通过，与本项目请求体无关。
 *
 * 实测（某企业内部网关，anthropic 协议 + 网关侧 thinking 模式，pro / flash 皆然）：
 * 一段普通会话会在**同一份请求体**下随机收到
 * `400 The 'reasoning_content' in the thinking mode must be passed back to the API.`
 * 2026-09-15 的排除法实验（真实会话载荷 + 交错抽样，剔除时间漂移）：
 *   · 剥不剥 thinking：原样（24 个块）与剥净（0 个块）各 3 轮，都是 2/3 —— **无差别**；
 *   · 载荷长短：131KB / 21 条 与 1KB / 5 条，失败率同级；
 *   · 模型：pro 6/6 与 flash 5/6 —— 无显著差别；
 *   · **决定性一条**：复用 9/9 当年跑通过的 1KB 老载荷今天重放 → 3/6 失败。
 *     同一份请求体过去成功、现在失败，说明根因在网关侧（行为变化 / 时间性故障窗口），
 *     而非"本项目某次改动引入的"——这条把"去改我们的请求体"整条路彻底堵死。
 *   · 补充事实：该网关**从不发 `signature_delta`**，它产出的 thinking 块天生没有 `signature`
 *     （Anthropic 规范里该字段必填），所以"当成签名缺失 / 回传不全去修"同样是死路。
 * 结论：唯一有效且安全的兜底就是**原样重发**（次数与退避见 retryTuning 的实测依据）。
 * 判定按错误文案收敛，避免把真正的配置类 400（模型名错、key 错）也重试掉。
 * --- @ty.aicoding@1789634086948 ---
 */
function isGatewayFlake(e: unknown): boolean {
  const msg = (e as Error)?.message || String(e);
  return /reasoning_content|thinking mode must be passed back/i.test(msg);
}

/**
 * 必须原样穿透的异常：中断 / 中止 / langgraph bubble-up。
 * 这类"错误"是控制流而非故障——重试会把审批闸门挂起和手动停止一并吞掉。
 * --- @ty.aicoding@1789465525482 ---
 */
function mustRethrow(e: unknown): boolean {
  const err = e as Error & { is_bubble_up?: boolean };
  return err?.name === "AbortError" || err?.name === "GraphInterrupt" || !!err?.is_bubble_up;
}

/** 取子回调（getChild 在 CallbackManager 上，ForLLMRun 类型未声明，运行时存在） */
function childManager(runManager?: CallbackManagerForLLMRun): unknown {
  return (runManager as unknown as { getChild?: () => unknown })?.getChild?.();
}

/**
 * 韧性 chat model 包装：两项能力合一——**备用模型降级** + **网关抖动重试**。
 *
 * 为什么不用 model.withFallbacks()：RunnableWithFallbacks 没有 bindTools，createReactAgent
 * 建图时会直接抛 "llm ... must define bindTools method"；而且它的 bound.bound 也不再是 ChatModel，
 * responseFormat（generate_structured_response 节点）同样要求拿到可 withStructuredOutput 的模型。
 * 因此这里继承 BaseChatModel 并自行透传 bindTools（返回仍是本类实例），两条路径都成立。
 *
 * 为什么必须实现 `_streamResponseChunks`：agent 走的是 `graph.stream()`，
 * 只实现 `_generate` 的 BaseChatModel 会让 `_streamIterator` 退化到"一次性返回整条消息"，
 * 前端打字机（delta 事件）会直接失效——所以流式钩子必须同样具备重试能力，
 * 且**只在"还没吐出任何增量"时重试**（已吐过增量再重发会把前半段重复推给前端）。
 * --- @ty.aicoding@1789465525482 ---
 */
class ResilientChatModel extends BaseChatModel<any> {
  private readonly chain: ModelRunnable[];
  private readonly label: string;

  constructor(chain: ModelRunnable[], label = "resilient-chat") {
    super({});
    if (chain.length === 0) throw new Error("ResilientChatModel 至少需要一个模型");
    this.chain = chain;
    this.label = label;
  }

  override _llmType(): string {
    return this.label;
  }

  /** 透传 bindTools：内部每个模型各绑同一批工具，包装本身仍留在链上（降级 + 重试能力不丢） */
  override bindTools(tools: BindToolsInput[], kwargs?: Record<string, unknown>): ResilientChatModel {
    const bound = this.chain.map((m) => {
      const fn = (m as unknown as { bindTools?: (t: BindToolsInput[], k?: Record<string, unknown>) => ModelRunnable }).bindTools;
      if (typeof fn !== "function") throw new Error("ResilientChatModel：内部模型不支持 bindTools，无法用于 createReactAgent");
      return fn.call(m, tools, kwargs);
    });
    return new ResilientChatModel(bound, this.label);
  }

  override async _generate(
    messages: BaseMessage[],
    options: Record<string, unknown>,
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    let lastErr: unknown;
    let tries = 0;
    const { attempts, baseMs, maxMs } = retryTuning();
    for (let i = 0; i < this.chain.length; i++) {
      // 同一节点先按「网关抖动」原样重试，重试用尽才降级到下一个模型
      for (let attempt = 1; attempt <= attempts; attempt++) {
        tries = attempt;
        try {
          const msg = await this.chain[i].invoke(messages, { ...options, callbacks: childManager(runManager) } as never);
          // 统一转 chunk：BaseChatModel.withStructuredOutput 的解析器只认 AIMessageChunk（core/structured_output.ts），
          // 普通 AIMessage 会让它抛 "Input is not an AIMessageChunk."
          const chunk = asChunk(msg);
          return { generations: [{ message: chunk, text: plainText(chunk.content) }] };
        } catch (e) {
          if (mustRethrow(e)) throw e;
          lastErr = e;
          if (isGatewayFlake(e) && attempt < attempts) {
            console.warn(`[llm] 网关抖动，原样重试（${attempt}/${attempts - 1}）：${(e as Error).message.slice(0, 140)}`);
            await sleep(backoffMs(attempt, baseMs, maxMs));
            continue;
          }
          break; // 非抖动错误 / 重试用尽 → 交给下一级备用模型
        }
      }
      if (i < this.chain.length - 1) {
        console.warn(`[llm] 模型调用失败，降级到备用模型（${i + 1}/${this.chain.length - 1}）：${(lastErr as Error)?.message || String(lastErr)}`);
      }
    }
    throw exhaustedFlakeError(lastErr, tries);
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: Record<string, unknown>,
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    let lastErr: unknown;
    let tries = 0;
    const { attempts, baseMs, maxMs } = retryTuning();
    for (let i = 0; i < this.chain.length; i++) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        tries = attempt;
        let yielded = false; // 本轮是否已向下游吐出增量：吐过就绝不再重试
        try {
          const stream = (await this.chain[i].stream(messages, {
            ...options,
            callbacks: childManager(runManager),
          } as never)) as AsyncIterable<BaseMessage>;
          for await (const c of stream) {
            const chunk = asChunk(c);
            yielded = true;
            // 生成元数据（finish_reason 等）由 _streamIterator 以 message.response_metadata 为准，
            // 这里只补必要的 text/message，够 graph 累积与前端渲染使用
            yield new ChatGenerationChunk({ text: plainText(chunk.content), message: chunk });
          }
          return;
        } catch (e) {
          if (mustRethrow(e)) throw e;
          lastErr = e;
          if (!yielded && isGatewayFlake(e) && attempt < attempts) {
            console.warn(`[llm] 网关抖动（流式），原样重试（${attempt}/${attempts - 1}）：${(e as Error).message.slice(0, 140)}`);
            await sleep(backoffMs(attempt, baseMs, maxMs));
            continue;
          }
          break;
        }
      }
      if (i < this.chain.length - 1) {
        console.warn(`[llm] 流式模型调用失败，降级到备用模型（${i + 1}/${this.chain.length - 1}）：${(lastErr as Error)?.message || String(lastErr)}`);
      }
    }
    throw exhaustedFlakeError(lastErr, tries);
  }
}

/**
 * 构建 agent 用的 chat model：始终套一层 ResilientChatModel——
 * 配置了备用模型时它负责降级，未配置时只保留"网关抖动原样重试"（失败即抛，行为与单模型一致）。
 * 恒包装的理由：该网关 400 与请求体无关（见 isGatewayFlake 注释），且发生在单模型场景，
 * 不包装就没有任何可重试的位置；包装本身对调用方完全透明（bindTools / 结构化输出 / 流式均透传）。
 * --- @ty.aicoding@1789465525482 ---
 */
export function buildAgentModel(cfg: LlmConfig): BaseChatModel<any> {
  const primary = buildChatModel(cfg);
  const fb = cfg.fallback;
  if (!fb?.model) {
    return new ResilientChatModel([primary] as unknown as ModelRunnable[], `resilient(${cfg.model})`);
  }
  // 备用模型独立解析协议/地址/key；不继承 contextTokens（窗口按各自模型名识别）
  const backup = buildChatModel({ ...cfg, ...fb, fallback: undefined, contextTokens: undefined });
  return new ResilientChatModel(
    [primary, backup] as unknown as ModelRunnable[],
    `resilient(${cfg.model}→${fb.model})`
  );
}

/** 审批闸门：interrupt() 送出的请求体（UI 据此渲染审批卡片） */
export interface ApprovalRequest {
  kind: "approval";
  tool: "run_shell";
  command: string;
  risk: string;
  ruleId: string;
  sample: string;
}

/** 审批闸门：Command({resume}) 回传的决定（兼容布尔简写） */
export type ApprovalDecision = boolean | { approved?: boolean; note?: string };

/** 判定审批结果：只认显式的批准 */
function approvedOf(d: ApprovalDecision): boolean {
  if (d === true) return true;
  return !!d && typeof d === "object" && d.approved === true;
}

/**
 * 构建沙箱工具集（root=该 agent 的工作区，所有读写/命令都被约束在 root 内）。
 *  ctx 带 groupId 时额外提供本地检索工具（群聊历史 / 工作区文件内容全文检索），
 *  让 agent 能找回上下文窗口之外的更早信息；ctx.store 同时存在时提供长期记忆工具
 *  （remember / recall，工作区作用域、跨会话与跨工作区重置存活）。
 *  ctx.web 生效（缺省开启）时提供联网工具：web_fetch 抓网页、web_search 搜网页
 *  （provider=off 只给 web_fetch）。
 *  ctx.approval 生效（缺省开启）时 run_shell 挂人工审批闸门：命中危险命令不直接执行，
 *  而是 interrupt 挂起整张图，等真人批准后再继续（见 approval.ts 的规则表）。
 *  ctx.allowed 非空时按白名单过滤（借鉴 Claude subagent：角色只拿到职责内的工具，
 *  协调者只读防"抢活"，如 lead 无 write_file/run_shell）。
 * --- @ty.aicoding@1789442083508 ---
 */
export function buildSandboxTools(
  root: string,
  ctx?: { groupId?: string; dataDir?: string; allowed?: string[]; web?: WebConfig; approval?: ApprovalConfig; store?: NodeSqliteStore }
) {
  const readFile = tool(
    async ({ path }: { path: string }) => sandboxReadFile(root, path),
    {
      name: "read_file",
      description: "读取工作区内一个文本文件的内容。path 为相对工作区的路径。",
      schema: z.object({ path: z.string().describe("相对工作区的文件路径") }),
    }
  );
  const writeFile = tool(
    async ({ path, content }: { path: string; content: string }) => sandboxWriteFile(root, path, content),
    {
      name: "write_file",
      description: "在工作区内写入（创建或覆盖）一个文本文件。path 为相对路径，content 为完整文件内容。",
      schema: z.object({
        path: z.string().describe("相对工作区的文件路径"),
        content: z.string().describe("要写入的完整文件内容"),
      }),
    }
  );
  const listDir = tool(
    async ({ path }: { path?: string }) => sandboxListDir(root, path || "."),
    {
      name: "list_dir",
      description: "列出工作区内某个目录的内容（文件与子目录）。path 为相对路径，留空表示工作区根目录。",
      schema: z.object({ path: z.string().optional().describe("相对工作区的目录路径，留空=根目录") }),
    }
  );
  const runShell = tool(
    async ({ command }: { command: string }) => {
      // 人工审批闸门：命中危险模式时挂起整张图（interrupt），真人批准后才真正执行。
      // 注意：LangGraph 恢复时会重跑被中断的 tools 节点，同一批次的其它工具调用会被重复执行，
      // 因此系统提示里要求把可能触发审批的命令单独调用（见 harness 的工具提示）。
      if (ctx?.approval?.enabled !== false) {
        const risk = detectDangerousCommand(command, ctx?.approval?.extraPatterns);
        if (risk) {
          const decision = interrupt<ApprovalRequest, ApprovalDecision>({
            kind: "approval",
            tool: "run_shell",
            command: command.slice(0, 2000),
            risk: risk.label,
            ruleId: risk.id,
            sample: risk.sample,
          });
          if (!approvedOf(decision)) {
            const note = typeof decision === "object" && decision?.note ? `审批意见：${decision.note}\n` : "";
            return `⛔ 该命令被判定为高危（${risk.label}），需要真人批准，本次未执行（已被拒绝或超时）。\n命令：${command}\n${note}请改用在自身工作区内的安全操作完成目标；确实必要时，向真人说明理由并请求重新批准后再试。`;
          }
        }
      }
      return sandboxRunShell(root, command);
    },
    {
      name: "run_shell",
      description:
        "在工作区内执行一条 shell 命令，返回 stdout+stderr。用于编译、运行、检查、安装依赖等。" +
        "高危命令（删除、推送、提权、读凭据、访问工作区外路径等）会被挂起等待真人批准后才执行，" +
        "因此这类命令请单独调用一次，不要与其它工具放在同一批。",
      schema: z.object({ command: z.string().describe("要执行的 shell 命令") }),
    }
  );
  const tools: StructuredToolInterface[] = [readFile, writeFile, listDir, runShell];

  // 本地检索工具（FTS5 trigram 全文索引，随项目启动初始化、增量维护）
  if (ctx?.groupId && ctx.dataDir) {
    const retrieval = getRetrieval(ctx.dataDir);
    const searchHistory = tool(
      async ({ query }: { query: string }) => formatChatHits(retrieval.searchChat(ctx.groupId!, query)),
      {
        name: "search_history",
        description:
          "检索当前工作区群聊的全部历史消息（包括更早的、已不在你当前记忆里的内容），按相关度返回消息（发送人+时间+片段）。当你需要回忆之前的讨论、决定、需求背景时使用。query 为关键词或描述性短语。",
        schema: z.object({ query: z.string().describe("搜索关键词或短语，如：网关超时 谁决定的") }),
      }
    );
    const searchWorkspace = tool(
      async ({ query }: { query: string }) => formatFileHits(retrieval.searchFiles(ctx.groupId!, query)),
      {
        name: "search_workspace",
        description:
          "在工作区全部文件内容中做全文检索（比 list_dir 更适合「哪个文件讲了什么」这类问题），返回匹配的文件路径与内容片段。找到后可用 read_file 读取完整内容。",
        schema: z.object({ query: z.string().describe("搜索关键词，如：数据库连接池配置") }),
      }
    );
    tools.push(searchHistory, searchWorkspace);
  }

  // 长期记忆工具（BaseStore 持久化，跨会话重置/跨工作区隔离）：工作区内所有成员共享同一份记忆
  if (ctx?.groupId && ctx.store) {
    const nsGroup = ctx.groupId;
    const store = ctx.store;
    const remember = tool(
      async ({ key, text }: { key: string; text: string }) => {
        const existed = store.remember(nsGroup, key, text);
        return `${existed ? "已更新" : "已记住"}长期记忆「${key}」。本工作区所有成员后续都能用 recall 查到它。`;
      },
      {
        name: "remember",
        description:
          "把一条「值得长期记住的事实」写入工作区共享长期记忆（跨会话重置、跨成员可见）：项目约定、技术选型及其理由、踩过的坑与规避方法、对外接口/字段口径、真人的偏好。key 用简短标题，text 写清楚结论与必要的上下文。与任务无关的临时信息不要记。",
        schema: z.object({
          key: z.string().describe("简短标题，如「结算口径-已确认」"),
          text: z.string().describe("要记住的内容：结论 + 必要上下文（≤500 字）"),
        }),
      }
    );
    const recall = tool(
      async ({ query }: { query: string }) => {
        const hits = store.searchWorkspaceMemory(nsGroup, query || "", 20);
        if (!hits.length) {
          return query
            ? `长期记忆里没有匹配「${query}」的条目。`
            : "长期记忆还是空的（本工作区还没人 remember 过任何内容）。";
        }
        const fmt = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
        return hits.map((h, i) => `${i + 1}. 【${h.key}】（${fmt(h.updatedAt)}）${h.text}`).join("\n");
      },
      {
        name: "recall",
        description:
          "查询工作区共享长期记忆（不在你的上下文窗口里，但被团队明确记录下来的既定事实）。开始一项任务前若能对上口径、或需要确认既有约定/决策时先查一下。query 留空=列出全部。",
        schema: z.object({ query: z.string().optional().describe("关键词，按 key 或内容模糊匹配；留空=列出全部") }),
      }
    );
    tools.push(remember, recall);
  }

  // 联网工具（总开关关闭则不注册 → 模型完全看不到，不产生"我能不能上网"的反复试探）
  if (ctx?.web?.enabled !== false) {
    const webFetchTool = tool(
      async ({ url }: { url: string }) => doWebFetch(url, ctx?.web),
      {
        name: "web_fetch",
        description:
          "抓取一个 http(s) 网址并返回其纯文本正文（自动去掉脚本/样式、按长度截断）。用于阅读已知地址的在线文档、issue、报错贴、API 说明等。失败会返回具体原因，可换地址重试。",
        schema: z.object({ url: z.string().describe("完整网址，如 https://nodejs.org/api/fs.html") }),
      }
    );
    tools.push(webFetchTool);
    // 搜索后端为 off 时只保留抓取（避免注册一个必定失败的工具）
    if ((ctx?.web?.search?.provider || DEFAULT_SEARCH_PROVIDER) !== "off") {
      const webSearchTool = tool(
        async ({ query }: { query: string }) => doWebSearch(query, ctx?.web),
        {
          name: "web_search",
          description:
            "联网搜索网页，返回「标题 + 链接 + 摘要」清单。适合查报错原因、找官方文档地址、了解某个库/API 的用法。拿到链接后可用 web_fetch 读正文。",
          schema: z.object({ query: z.string().describe("搜索关键词，如 node:sqlite DatabaseSync 用法") }),
        }
      );
      tools.push(webSearchTool);
    }
  }
  // 工具白名单（模型层聚焦引导，非安全边界——沙箱路径约束才是）
  if (ctx?.allowed?.length) {
    const allow = new Set(ctx.allowed);
    return tools.filter((t) => allow.has(t.name));
  }
  return tools;
}
