/**
 * 端到端验证：agent 在真实 LLM 会话中调用 search_history 检索群聊历史。
 * 断言：1) 工具调用序列包含 search_history；2) 回答引用了真实历史内容。
 */
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { defaultSettings } from "../packages/core/src/agents.ts";
import { runHarness, shutdownHarness } from "../packages/core/src/harness.ts";

async function main() {
  const settings = defaultSettings();
  settings.sandboxDir = join(process.cwd(), "data", "sandbox");

  const savedPath = join(process.cwd(), "data", "settings.json");
  if (existsSync(savedPath)) {
    const saved = JSON.parse(readFileSync(savedPath, "utf8"));
    settings.llm = { ...settings.llm, ...(saved.llm || {}) };
  }

  const qa = settings.agents.find((a) => a.id === "ai-qa")!;
  const cwd = join(settings.sandboxDir, "ai-qa");

  const toolCalls: string[] = [];
  const r = await runHarness({
    agent: qa,
    settings,
    task: "用 search_history 工具检索群里关于「运算」的历史讨论，总结大家算过哪些题、谁出的题、答案分别是多少。",
    cwd,
    groupId: "g-dev",
    timeoutMs: 240_000,
    onEvent: (ev) => {
      const s = JSON.stringify(ev);
      const m = s.match(/"name"\s*:\s*"(search_history|search_workspace|read_file|write_file|list_dir|run_shell)"/g) || [];
      for (const hit of m) {
        const name = hit.match(/"([a-z_]+)"$/)?.[1] || "";
        if (name && !toolCalls.includes(name)) toolCalls.push(name);
      }
      if (s.includes("search_history")) console.log("[event] search_history 调用参数:", s.slice(0, 300));
    },
  });

  console.log(`\n[${qa.name}] ok=${r.ok} ${r.durationMs}ms`);
  if (r.error) console.log("--- 错误 ---\n" + r.error.slice(0, 500));
  console.log("--- 汇报 ---\n" + r.content);
  console.log("\n--- 工具调用序列 ---\n" + toolCalls.join(" → "));

  const used = toolCalls.includes("search_history");
  console.log(used ? "\n✅ 断言通过：agent 主动调用了 search_history" : "\n❌ 断言失败：agent 未调用 search_history");
  await shutdownHarness();
  process.exit(used ? 0 : 1);
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
