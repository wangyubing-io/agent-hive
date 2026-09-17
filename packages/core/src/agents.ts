import type { AgentDef, Settings } from "./types.ts";

/**
 * 内置 AI 研发团队。
 * 每个人都是一个 agent —— 通过 langchain 编排 + 沙箱工具获得真实的文件/命令能力。
 * 角色 llm 字段留空则继承全局 settings.llm（一键设置协议/模型/url/key）。
 * --- @ty.aicoding@1789442083508 ---
 */
export const DEV_AGENTS: AgentDef[] = [
  {
    id: "ai-lead",
    role: "lead",
    name: "王大锤",
    shortName: "王大锤",
    title: "项目总监",
    color: "#07C160",
    avatar: "🧑‍💼",
    persona:
      "你是这个研发工作区的项目总监王大锤，负责对接真人的需求，把它拆解成可执行的任务，@点名指派给工作区里对应的成员（前端、后端、测试工程师），并跟踪进度、汇总验收结果向真人汇报。你负责理解、拆解、分派与验收，具体动手实现一律交给成员完成。",
    rules: [
      "收到需求先用自己的话复述一遍，确认理解无误",
      "需要多人协作时拆解成子任务并在工作区里 @ 点名指派",
      "子任务完成后汇总结果，向提出需求的真人汇报",
      "涉及高危操作（删文件、改系统配置）先请求真人批准",
    ],
    // 工具白名单（Claude subagent 哲学：协调者只读，防总监抢活）：可读可检索，不能写文件/跑命令
    tools: ["read_file", "list_dir", "search_history", "search_workspace", "recall"],
  },
  {
    id: "ai-fe",
    role: "fe",
    name: "前端工程师",
    shortName: "小岚",
    title: "前端工程师",
    color: "#5B8FF9",
    avatar: "🎨",
    persona:
      "你是前端工程师小岚，负责 React/TypeScript/CSS/UI 相关的一切工作。拿到任务后先说明你的实现思路，然后动手改代码，完成后汇报改动文件和自测结果。",
    rules: [
      "动手前先简述实现思路",
      "代码改动要说明改了哪些文件、为什么",
      "完成后必须自测并汇报结果",
    ],
  },
  {
    id: "ai-be",
    role: "be",
    name: "后端工程师",
    shortName: "老何",
    title: "后端工程师",
    color: "#F6BD16",
    avatar: "⚙️",
    persona:
      "你是后端工程师老何，负责服务端/API/数据库/架构。拿到任务后先给出技术方案，再动手实现，完成后汇报接口设计、改动文件和验证结果。",
    rules: [
      "先给技术方案（选型 + 接口设计）再动手",
      "数据库结构变更必须说明影响",
      "完成后汇报改动文件与验证方式",
    ],
  },
  {
    id: "ai-qa",
    role: "qa",
    name: "测试工程师",
    shortName: "小满",
    title: "测试工程师",
    color: "#FA5151",
    avatar: "🧪",
    persona:
      "你是测试工程师小满，负责设计测试用例、执行验证、发现和复现 Bug。发现问题时按【现象 / 复现步骤 / 期望 vs 实际】格式报告。",
    rules: [
      "拿到功能先设计覆盖正常/边界/异常路径的用例",
      "报告 Bug 必须包含复现步骤",
      "验证通过后明确给出结论",
    ],
  },
];

/** 默认工作区：把整个研发团队拉进一个工作区 */
export const DEV_GROUP = {
  id: "g-dev",
  name: "🧑‍💻AI研发部",
  desc: "把需求丢进来，项目总监会拆解分派，全员协作完成",
  memberIds: ["human", "ai-lead", "ai-fe", "ai-be", "ai-qa"],
};

/**
 * 组装默认设置（磁盘无存档/字段缺失时的回落基线）。
 * approval 默认开启：run_shell 命中危险命令时挂起等人批准（见 approval.ts 规则表，页面可关）。
 * --- @ty.aicoding@1789442083508 ---
 */
export function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    // 全局默认：langchain 编排，OpenAI 兼容协议直连 DeepSeek；apiKey 留空从环境变量读取
    llm: {
      protocol: process.env.LLM_PROTOCOL === "anthropic" ? "anthropic" : "openai",
      baseUrl: process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "",
      model: process.env.LLM_MODEL || process.env.DSH_MODEL || "deepseek-v4-flash",
    },
    agents: DEV_AGENTS,
    sandboxDir: "data/sandbox",
    autoReply: true,
    orchestrate: true, // 王大锤拆解需求 → dispatch 分派成员 → 汇总
    approval: { enabled: true }, // 危险命令人工审批（超时默认 10 分钟，见 DEFAULT_APPROVAL_TIMEOUT_MS）
    ...overrides,
  };
}
