// 项目总监拆解计划的数据契约：结构化输出 schema + 两种来源（结构化 / dispatch 代码块）的归一化。
// 为什么单独成模块：拆解是整个编排链路的第一环，也是最脆弱的一环——
//   LLM 输出的 JSON 代码块一旦格式不合法，旧实现会静默返回 null（退化成"不拆解"），
//   真人只看到总监说了计划、但没有任何成员开工，且完全不知道哪里出了问题。
//   现在有两条路：① responseFormat 结构化输出（schema 校验，主路径）；
//   ② dispatch 代码块解析（兜底，且能区分"没写"和"写了但解析不了"→ 前者正常、后者要报给真人）。
import { z } from "zod";

export interface DispatchSubtask {
  agent?: string;
  task?: string;
  dependsOn?: number[]; // 0-based 依赖子任务下标（LLM 按 1-based 输出，归一化时 -1）
}

export interface DispatchPlan {
  subtasks: DispatchSubtask[];
  self?: string;
}

/** dispatch 代码块（兜底路径）：```dispatch { ... } ``` */
export const DISPATCH_RE = /```dispatch\s*([\s\S]*?)```/;

/** 子任务数量上限（与提示词里的"最多 4 个"一致；超出直接截断，防一次分派把并发打爆） */
export const MAX_SUBTASKS = 4;

/**
 * 结构化输出 schema（responseFormat 主路径）。
 * 字段描述即"提示词"：结构化调用时以 function calling 的形式喂给模型，描述写得越具体越稳。
 * --- @ty.aicoding@1789442083508 ---
 */
export const DISPATCH_PLAN_SCHEMA = z.object({
  subtasks: z
    .array(
      z.object({
        agent: z.string().describe("承接该子任务的成员短名，必须取自提示词给出的名单"),
        task: z.string().describe("具体、可执行、小而聚焦的子任务描述（含足够上下文）；单个子任务应能在十几步工具操作内完成，更大的必须再拆细"),
        dependsOn: z
          .array(z.number())
          .optional()
          .describe("该子任务依赖的子任务序号（从 1 开始计数）；无依赖不要填，能并行的尽量并行"),
      })
    )
    .max(MAX_SUBTASKS)
    .describe("需要分派给成员的子任务；简单需求不需要协作时给空数组"),
  self: z.string().optional().describe("项目总监自己要动手做的部分（通常是最后的核查/整理）；没有则留空"),
});

/**
 * 归一化任意来源的拆解计划（结构化输出对象 / 解析出的 JSON 对象）。
 * 统一做：字段类型校验、子任务截断到 MAX_SUBTASKS、dependsOn 1-based→0-based、
 * 过滤越界/自指/重复依赖、以及"空子任务且空 self"视为无效计划。
 * --- @ty.aicoding@1789442083508 ---
 */
export function normalizeDispatchPlan(raw: unknown): DispatchPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { subtasks?: unknown; self?: unknown };
  if (!Array.isArray(obj.subtasks)) return null;
  const subtasks: DispatchSubtask[] = obj.subtasks.slice(0, MAX_SUBTASKS).map((s, i) => {
    const st = (s ?? {}) as Record<string, unknown>;
    return {
      agent: typeof st.agent === "string" ? st.agent : undefined,
      task: typeof st.task === "string" ? st.task : undefined,
      // dependsOn：LLM 按 1-based 序号输出 → 归一化 0-based，过滤越界/自指/重复
      dependsOn: Array.isArray(st.dependsOn)
        ? [...new Set(
            (st.dependsOn as unknown[])
              .map((d) => Math.trunc(Number(d)))
              .filter((d) => d >= 1 && d <= MAX_SUBTASKS && d !== i + 1)
              .map((d) => d - 1)
          )]
        : [],
    };
  });
  const self = typeof obj.self === "string" ? obj.self : "";
  if (subtasks.length === 0 && !self.trim()) return null; // 无需协作的直接回答
  return { subtasks, self };
}

/**
 * 从自由文本里解析 dispatch 代码块（兜底路径）。
 * 返回 { plan, malformed }：plan=null 且 malformed=true 表示"写了 dispatch 块但 JSON 不合法"——
 * 调用方应据此给真人一个明确提示，而不是像旧实现那样静默当成"不需要分派"。
 * --- @ty.aicoding@1789442083508 ---
 */
export function parseDispatchBlock(text: string): { plan: DispatchPlan | null; malformed: boolean } {
  const m = (text || "").match(DISPATCH_RE);
  if (!m) return { plan: null, malformed: false }; // 压根没写 = 正常（简单需求直接回答）
  try {
    return { plan: normalizeDispatchPlan(JSON.parse(m[1])), malformed: false };
  } catch {
    return { plan: null, malformed: true };
  }
}

/** 成员回报的结构化三段（【结果】【产出】【风险】） */
export interface MemberReport {
  result: string;
  outputs: string;
  risks: string;
}

/**
 * 解析子任务回报里的结构化三段（【结果】【产出】【风险】）——编排看板据此统计产出与风险。
 * 为什么解析正文而不是再开一次 withStructuredOutput：成员回复本身就被要求按这三段写（见编排提示词），
 * 多一次结构化调用等于白花一次 LLM 往返且可能失败；正文解析零成本、失败也只是"没有明细"。
 * 三段全空视为未按格式回报（返回 null），调用方回落展示原始摘要。
 * --- @ty.aicoding@1789443562072 ---
 */
export function parseReport(text: string): MemberReport | null {
  const s = text || "";
  if (!s) return null;
  const pick = (label: string) => {
    // 到下一个【xxx】或文本结尾为止；跨行合并为单行（看板一行展示）
    const m = new RegExp(`【${label}】([\\s\\S]*?)(?=【|$)`).exec(s);
    return m ? m[1].trim().replace(/\s+/g, " ").slice(0, 600) : "";
  };
  const result = pick("结果");
  const outputs = pick("产出");
  const risks = pick("风险");
  if (!result && !outputs && !risks) return null;
  return { result, outputs, risks };
}
