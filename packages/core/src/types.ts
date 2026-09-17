/** LLM 接入协议：openai=OpenAI 兼容（含 DeepSeek）· anthropic=Anthropic 兼容（Claude / DeepSeek anthropic 端点） */
export type LlmProtocol = "openai" | "anthropic";

/**
 * 单个角色的 LLM 接入配置（可全局统一，也可每角色覆盖）。
 * --- @ty.aicoding@1789442083508 ---
 */
export interface LlmConfig {
  protocol?: LlmProtocol; // 协议，默认 openai（OpenAI 兼容，DeepSeek 走此协议）
  baseUrl?: string; // 自定义 API 地址，留空用协议默认（openai→api.deepseek.com / anthropic→api.anthropic.com）
  model: string; // 如 deepseek-v4-flash / deepseek-v4-pro / claude-...
  apiKey?: string; // 为空则回落到环境变量
  apiKeyEnv?: string; // 从哪个环境变量读 key（优先级高于 apiKey 字段的缺省）
  contextTokens?: number; // 上下文窗口（tokens）。留空 = 按模型名自动识别（见 modelContext.ts），可手动覆盖
  fallback?: Partial<LlmConfig>; // 备用模型：主模型单次调用失败（连接失败/超时/5xx）时自动降级重试，模型名必填
}

/**
 * 危险命令人工审批配置（run_shell 的 interrupt() 闸门）。
 * 开启后，命中危险模式的命令不会直接执行，而是把图挂起、在工作区弹出审批卡片，
 * 由真人「批准 / 拒绝」后再继续（见 harness 的 paused 结果与 resume 续跑）。
 * --- @ty.aicoding@1789442083508 ---
 */
export interface ApprovalConfig {
  enabled?: boolean; // 总开关，默认 true（关掉=run_shell 不再拦截，恢复旧行为）
  extraPatterns?: string[]; // 追加的危险命令正则（字符串源，编译失败自动忽略）
  timeoutMs?: number; // 等待人工审批超时（默认 600000 = 10 分钟），超时视为拒绝
}

/**
 * 联网搜索后端：bing=免 key 国内可直连（默认）· duckduckgo=免 key 公网 · searxng=自建/内网实例 · bocha=博查（国内商用） · tavily=需 key · off=关闭搜索
 * --- @ty.aicoding@1789436639812 ---
 */
export type WebSearchProvider = "bing" | "duckduckgo" | "searxng" | "bocha" | "tavily" | "off";

/**
 * 联网搜索配置（web_search 工具的后端选择）。
 * --- @ty.aicoding@1789436639812 ---
 */
export interface WebSearchConfig {
  provider?: WebSearchProvider; // 缺省 bing（免 key、国内可直连）
  baseUrl?: string; // searxng 实例地址（如 http://192.168.1.10:8080）、Bing 镜像或自定义端点
  apiKey?: string; // bocha / tavily 需要；留空回落环境变量（BOCHA_API_KEY / TAVILY_API_KEY）
  count?: number; // 返回条数，默认 8（钳在 1~20）
}

/**
 * 联网能力配置（web_fetch 抓网页 / web_search 搜网页）。
 * 由页面「设置 → 联网」写入，留空即全默认；web.enabled=false 时两个工具都不注册（模型看不到）。
 * --- @ty.aicoding@1789436639812 ---
 */
export interface WebConfig {
  enabled?: boolean; // 联网工具总开关（默认 true）
  allowPrivateHosts?: boolean; // 允许抓内网/本机地址（默认 true——内网文档站；关掉=仅公网，含 DNS 解析后判定）
  fetchTimeoutMs?: number; // 单次请求超时，默认 20000
  fetchMaxBytes?: number; // 原始响应体积上限，默认 2MB
  fetchMaxChars?: number; // 交给模型的正文字符上限，默认 8000
  search?: WebSearchConfig;
}

export type AgentRoleId = "lead" | "fe" | "be" | "qa" | "ops" | "design" | "human";

/** 一个 AI 角色 = 一个 agent。通过 langchain 编排 + 沙箱工具获得真实的文件/命令能力 */
export interface AgentDef {
  id: string; // 如 "ai-lead"
  role: AgentRoleId;
  name: string; // 工作区里显示名，如 "项目总监·王大锤"
  shortName: string; // 昵称
  title: string;
  color: string; // 工作区昵称颜色（十六进制）
  avatar: string; // emoji
  persona: string; // 人设/职责描述（进 system prompt）
  rules?: string[]; // 工作规则，如"先复述需求再动手"
  tools?: string[]; // 工具白名单（借鉴 Claude subagent 哲学：协调者只读、动手者全量）。缺省=全部工具。
  // 注意：这是模型层聚焦引导（防总监抢活/越权代做），不是安全边界——真正的约束是沙箱路径限制。
  llm?: Partial<LlmConfig>; // 角色级模型覆盖（如 lead 用强模型、成员用轻模型，即模型路由）
}

export interface GroupDef {
  id: string;
  name: string;
  desc: string;
  memberIds: string[]; // agent id + "human"
  createdAt: number;
}

export type MsgKind = "text" | "task" | "system" | "file" | "image";

/** 消息附件（真人上传的文件/图片，agent 可通过注入的路径读取） */
export interface FileAttachment {
  id: string; // 上传文件 id（对应 data/uploads/<groupId>/<id>_<name>）
  name: string; // 原始文件名
  size: number;
  mime?: string; // 如 image/png
  url?: string; // 相对下载/展示路径，如 /api/uploads/<groupId>/<id>_<name>
}

/** 一条思考过程记录（agent 推理/工具链/错误，随回复落盘，UI 折叠展示） */
export interface TraceEntry {
  kind: "step" | "tool" | "result" | "think" | "error";
  text: string;
  ok?: boolean;
}

export interface ChatMsg {
  id: string;
  groupId: string;
  senderId: string;
  senderName: string;
  senderAccount?: string; // 真人消息：发送人的域账号（用于区分"我"与他人；旧数据无此字段视为本机）
  kind: MsgKind;
  text: string;
  attachments?: FileAttachment[]; // 文件/图片消息的附件
  trace?: TraceEntry[]; // agent 回复的思考过程（推理步骤 + 工具调用 + 结果）
  ts: number;
}

/**
 * 全局设置：默认模型 + 内置角色 + 调度开关。
 * --- @ty.aicoding@1789442083508 ---
 */
export interface Settings {
  llm: LlmConfig; // 全局默认
  agents: AgentDef[];
  sandboxDir: string; // agent 只能在这个目录内干活
  autoReply: boolean; // 真人发言后主 agent 是否自动接管
  orchestrate?: boolean; // 项目总监是否拆解需求并分派给成员（默认 true）
  web?: WebConfig; // 联网能力（web_fetch / web_search 工具）
  approval?: ApprovalConfig; // 危险命令人工审批（run_shell 的 interrupt 闸门）
}
