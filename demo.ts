import { join } from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { defaultSettings } from "./packages/core/src/agents.ts";
import { runHarness } from "./packages/core/src/harness.ts";
/**
 * 端到端验证：真人把需求丢进"AI研发部"群，后端（ai-be）
 * 通过 langchain 编排 + 沙箱工具真正动手干活并汇报。
 */
async function main() {
  const settings = defaultSettings();
  const sandbox = join(process.cwd(), "data", "sandbox");
  mkdirSync(sandbox, { recursive: true });
  settings.sandboxDir = sandbox;

  // 加载页面保存的 LLM 配置（demo 直接可跑；缺省回落 env/默认值）
  const savedPath = join(process.cwd(), "data", "settings.json");
  if (existsSync(savedPath)) {
    const saved = JSON.parse(readFileSync(savedPath, "utf8"));
    settings.llm = { ...settings.llm, ...(saved.llm || {}) };
  }

  const be = settings.agents.find((a) => a.id === "ai-be")!;
  console.log(`[群] 真人: @老何 帮我在沙箱里写一个极简 HTTP 服务 server.js，监听 8787，访问 / 返回 "hello from agent-hive"。写完用 node --check 验证语法。\n`);

  const r = await runHarness({
    agent: be,
    settings,
    task: "真人在群里 @你：写一个极简 HTTP 服务 server.js 放到沙箱根目录，用 node 原生 http 模块，监听 8787 端口，访问 / 返回文本 hello from agent-hive。写完用 node --check server.js 验证语法通过。",
    cwd: sandbox,
    timeoutMs: 240_000,
  });

  console.log(`[${be.name}] ok=${r.ok} ${r.durationMs}ms channel=${r.channel}`);
  if (r.error) console.log("--- 错误 ---\n" + r.error.slice(0, 800));
  if (r.stderr) console.log("--- stderr ---\n" + r.stderr.slice(0, 800));
  console.log("--- 汇报 ---\n" + r.content);

  // 验证产物
  const plan = join(sandbox, "server.js");
  if (existsSync(plan)) {
    const text = readFileSync(plan, "utf8");
    console.log(`\n✅ 产物验证: server.js 已生成 (${text.length} 字符)`);
    console.log(text.slice(0, 400));
  } else {
    console.log(`\n❌ 未发现产物: ${plan}`);
  }
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
