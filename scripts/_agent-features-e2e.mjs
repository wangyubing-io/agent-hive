// 端到端验证：① 备用模型降级 ② 危险命令审批闸门（interrupt 挂起 → Command(resume) 续跑）
//            ③ 批准后真正执行 ④ 长期记忆 remember / recall（跨会话共享）
// 用项目本机的 data/settings.json 里的真实 LLM 接入配置（脚本内不落任何密钥）。
// 隔离：所有数据落在 data/tests/agent-features/ 下（会话库/记忆库/检索库/沙箱），跑完清理。
// 用法：npm run test:e2e:agent-features（或用 STEPS=2,3 只跑指定步骤）
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const BASE = join(ROOT, "data", "tests", "agent-features");
const SANDBOX = join(BASE, "sandbox");

const cfg = JSON.parse(readFileSync(join(ROOT, "data", "settings.json"), "utf8"));
const LLM = cfg.llm;
if (!LLM?.apiKey || !LLM?.baseUrl) {
  console.error("!! data/settings.json 缺少 llm.apiKey / llm.baseUrl，无法跑真实网关验证");
  process.exit(1);
}

const { runHarness, shutdownHarness } = await import("../packages/core/src/harness.ts");

const AGENT = {
  id: "probe",
  role: "be",
  name: "探针",
  shortName: "探针",
  title: "测试探针",
  color: "#000000",
  avatar: "🧪",
  persona: "你是测试探针，只做被要求的那一件事，然后用一句话汇报结果，不要额外发挥。",
};

function settingsWith(patch = {}) {
  const { llm: llmPatch, ...rest } = patch;
  return {
    llm: { protocol: LLM.protocol, baseUrl: LLM.baseUrl, model: LLM.model, apiKey: LLM.apiKey, ...(llmPatch || {}) },
    agents: [AGENT],
    sandboxDir: SANDBOX,
    autoReply: false,
    orchestrate: false,
    web: { enabled: false },
    approval: { enabled: true },
    ...rest,
  };
}

let pass = 0;
let fail = 0;
const ONLY = new Set((process.env.STEPS || "1,2,3,4").split(","));
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};
/** 失败时把原始结果打出来（否则只有一行 ✅/❌ 无法定位） */
const dump = (label, r) =>
  console.log(`    ${label}: ok=${r?.ok} paused=${r?.paused} aborted=${r?.aborted} timedOut=${r?.timedOut} error=${r?.error || "-"} content=${JSON.stringify((r?.content || "").slice(0, 120))}`);

// ---------- ① 备用模型降级：主模型地址指向一个必然连不上的端口 ----------
console.log("\n[1] 备用模型降级");
if (ONLY.has("1")) {
  const settings = settingsWith({
    llm: {
      // 主模型：不可达（连接必然被拒）；备用模型：真实网关
      baseUrl: "http://127.0.0.1:9",
      fallback: { protocol: LLM.protocol, baseUrl: LLM.baseUrl, model: LLM.model, apiKey: LLM.apiKey },
    },
  });
  const t0 = Date.now();
  const r = await runHarness({
    agent: AGENT,
    settings,
    task: "只回复两个字：收到。不要调用任何工具。",
    cwd: join(SANDBOX, "fallback"),
    timeoutMs: 180_000,
  });
  ok("主模型不可达时任务仍成功（走了备用模型）", r.ok === true, `ok=${r.ok} ${Date.now() - t0}ms`);
  ok("回复内容非空", !!r.content.trim(), JSON.stringify(r.content.slice(0, 60)));
  if (!r.ok) dump("结果 1", r);
}

// ---------- ② 审批闸门：危险命令挂起 → 拒绝 → 续跑收敛 ----------
console.log("\n[2] 审批闸门（拒绝）");
if (ONLY.has("2")) {
  const settings = settingsWith({});
  const cwd = join(SANDBOX, "approval");
  const t0 = Date.now();
  const paused = await runHarness({
    agent: AGENT,
    settings,
    task: "执行这条 shell 命令并汇报结果：rm -rf ./approval-probe-dir\n（只调用一次 run_shell，不要做别的事）",
    cwd,
    timeoutMs: 180_000,
  });
  ok("图被挂起（paused=true）", paused.paused === true, `paused=${paused.paused} ${Date.now() - t0}ms`);
  if (!paused.paused) dump("结果 2", paused);
  const req = paused.interrupt?.value;
  ok("中断载荷是审批请求", req?.kind === "approval", JSON.stringify(req ?? null).slice(0, 200));
  ok("识别出 rm -rf 风险", req?.ruleId === "rm-recursive", `ruleId=${req?.ruleId}`);

  const resumed = await runHarness({
    agent: AGENT,
    settings,
    task: "", // 续跑不注入新任务
    cwd,
    resume: { approved: false, note: "测试：拒绝" },
    timeoutMs: 180_000,
  });
  ok("拒绝后续跑正常收敛", resumed.ok === true && !resumed.paused, `ok=${resumed.ok} paused=${resumed.paused}`);
  ok("模型被告知命令未执行", /拒绝|未执行/.test(resumed.content), JSON.stringify(resumed.content.slice(0, 80)));
  if (!resumed.ok) dump("结果 2b", resumed);
}

// ---------- ③ 审批闸门：批准后真正执行 ----------
console.log("\n[3] 审批闸门（批准 → 真正执行）");
if (ONLY.has("3")) {
  const settings = settingsWith({});
  const cwd = join(SANDBOX, "approve-exec");
  const t0 = Date.now();
  const paused = await runHarness({
    agent: AGENT,
    settings,
    task: "执行这条 shell 命令并汇报 shell 的输出：printf 'probe-ok' > ./probe.txt && rm -rf ./nothing-here\n（只调用一次 run_shell）",
    cwd,
    timeoutMs: 180_000,
  });
  ok("图被挂起（paused=true）", paused.paused === true, `paused=${paused.paused} ${Date.now() - t0}ms`);
  const ruleId = paused.interrupt?.value?.ruleId;
  if (paused.paused) {
    const resumed = await runHarness({
      agent: AGENT,
      settings,
      task: "",
      cwd,
      resume: { approved: true, note: "测试：批准" },
      timeoutMs: 180_000,
    });
    ok("批准后任务跑完", resumed.ok === true && !resumed.paused, `ok=${resumed.ok}`);
    const wrote = existsSync(join(cwd, "probe.txt"));
    ok("命令被真正执行（probe.txt 已生成）", wrote, `ruleId=${ruleId}`);
    if (!resumed.ok) dump("结果 3b", resumed);
  } else {
    fail++;
    console.log("  ❌ 未挂起，跳过批准执行校验（模型本批可能没调 run_shell）");
  }
}

// ---------- ④ 长期记忆：remember 写入 → recall 读回（跨会话/跨成员共享） ----------
console.log("\n[4] 长期记忆 remember / recall");
if (ONLY.has("4")) {
  const { NodeSqliteStore, memoryDbPath } = await import("../packages/core/src/sqlite-store.ts");
  const groupId = "probe-group";
  const settings = settingsWith({});
  const cwd = join(SANDBOX, "memory");
  const FACT = "本项目的测试流程是先跑离线单测，再跑端到端验证";

  const wrote = await runHarness({
    agent: AGENT,
    settings,
    groupId, // 提供检索/记忆工具（无 groupId 时 remember/recall 不注册）
    task: `请把这条事实写入长期记忆，key 用「测试口径」，内容原文照抄：${FACT}\n（只调用一次 remember 工具）`,
    cwd,
    timeoutMs: 180_000,
  });
  ok("remember 调用后任务成功", wrote.ok === true, `ok=${wrote.ok}`);
  const store = NodeSqliteStore.getInstance(memoryDbPath(BASE));
  const rows = store.listWorkspaceMemory(groupId, 50);
  ok("长期记忆里确有该工作区的条目", rows.length > 0, `条数=${rows.length}`);
  ok("写入内容与原文一致（原文照抄）", JSON.stringify(rows).includes("离线单测"), JSON.stringify(rows).slice(0, 160));
  NodeSqliteStore.resetInstance();

  const read = await runHarness({
    agent: AGENT,
    settings,
    groupId,
    task: "用 recall 工具查一下长期记忆里的「测试口径」，把查到的结论复述出来。",
    cwd,
    timeoutMs: 180_000,
  });
  ok("recall 能读回该事实", read.ok === true && /离线单测/.test(read.content), JSON.stringify(read.content.slice(0, 100)));
}

await shutdownHarness();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);

// 收尾清理：sqlite 句柄不关，Windows 上 rm 会 EBUSY（静默失败会留下垃圾文件）
try {
  const { RetrievalIndex } = await import("../packages/core/src/retrieval.ts");
  RetrievalIndex.resetInstance();
} catch { /* 未用到检索索引时忽略 */ }
let cleaned = false;
for (let i = 0; i < 3 && !cleaned; i++) {
  try {
    rmSync(BASE, { recursive: true, force: true });
    cleaned = !existsSync(BASE);
  } catch {
    await new Promise((r) => setTimeout(r, 200)); // 句柄释放有延迟，重试几次
  }
}
console.log(cleaned ? "已清理临时数据 data/tests/agent-features" : `!! 临时数据未能清理（句柄占用），请手动删除 ${BASE}`);
process.exit(fail === 0 ? 0 : 1);
