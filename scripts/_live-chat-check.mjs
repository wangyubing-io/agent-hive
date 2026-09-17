// 活体验收：真实服务 + 真实 LLM 的完整对话链路（走 socket，与 UI 完全同一条路）
// 验证点:
//  1) 普通对话跑通：流式 delta 打字机 + 工具调用事件 + 最终回复 + 产物真的落盘
//  2) 审批闸门（拒绝）：危险命令挂起 → 出审批卡 → 拒绝 → 回复明确"未执行" + 命令确实没跑
//  3) 审批闸门（批准）：挂起 → 批准 → 命令真正执行（产物文件存在）
//  4) 长期记忆：remember 写入 → recall 读回（并直查 sqlite 确认落库）
//  5) 设置项：备用模型 / 安全审批 存取 → 广播 + 落盘；非法正则被拒；末尾复位
// 清理：无论成败都会删掉临时工作区（未捕获异常也走 cleanupTmpGroup 兜底）
// 用法：先起服务（npm run dev），再
//   npm run test:e2e:live  /  STEPS=2,3 node scripts/_live-chat-check.mjs
// --- @ty.aicoding@1789466961397 ---
import { io } from "socket.io-client";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const URL = process.env.HIVE_URL || "http://127.0.0.1:18741";
const ACCOUNT = process.env.HIVE_ACCOUNT || "tester";
const ROOT = process.cwd();
const SANDBOX = join(ROOT, "data", "sandbox", "ai-be"); // 老何（ai-be）未绑定目录时的沙箱
const SETTINGS_FILE = join(ROOT, "data", "settings.json");
const MEMORY_DB = join(ROOT, "data", "agent-memory.db");
const TASK_TIMEOUT = Number(process.env.TASK_TIMEOUT || 240_000);

const ONLY = new Set((process.env.STEPS || "1,2,3,4,5").split(","));
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const head = (t, n = 120) => String(t || "").replace(/\s+/g, " ").slice(0, n);
const uniq = () => `【验收 ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}，全新需求直接执行，不必与历史核对】`;

// ---------------- socket 客户端 ----------------
const sock = io(URL, { transports: ["websocket"] });
const waitConnect = new Promise((res, rej) => {
  sock.on("connect", res);
  sock.on("connect_error", (e) => rej(new Error(`connect_error: ${e.message}`)));
});
const emit = (ev, payload) => new Promise((r) => sock.emit(ev, payload, r));

/** 等一个满足条件的广播事件（超时抛错） */
const waitEv = (ev, pred, timeout = TASK_TIMEOUT) =>
  new Promise((resolve, reject) => {
    const h = (p) => {
      let hit = false;
      try { hit = !pred || pred(p); } catch { hit = false; }
      if (hit) { clearTimeout(t); sock.off(ev, h); resolve(p); }
    };
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error(`等 ${ev} 超时`)); }, timeout);
    sock.on(ev, h);
  });

await waitConnect;
console.log(`已连接 ${URL}`);

const login = await emit("login", { account: ACCOUNT });
if (!login?.ok) {
  console.error(`登录失败（${ACCOUNT}）：${login?.error || "未知"}`);
  process.exit(1);
}
console.log(`登录 OK：${login.user?.name || ACCOUNT}`);

// 专用临时工作区（跑完删掉，不污染 g-dev 的真实记录）
const created = await emit("createGroup", { name: `🧪 验收-${Date.now().toString(36)}` });
if (!created?.ok) {
  console.error("建临时工作区失败：", created?.error);
  process.exit(1);
}
const GID = created.group.id;
console.log(`临时工作区：${GID}\n`);

const inGroup = (p) => p && p.groupId === GID;
const fromBe = (m) => inGroup(m) && m.senderId === WORKER.id;

// 被点名的成员短名从本机 settings.json 读（各人可能改过昵称，写死「老何」会 @ 不中而落到 lead 接管）
let WORKER = { id: "ai-be", shortName: "老何" };
try {
  const agents = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")).agents || [];
  const pick = agents.find((a) => a.role === "be") || agents.find((a) => a.role !== "lead") || agents[0];
  if (pick?.id) WORKER = { id: pick.id, shortName: pick.shortName || pick.name || pick.id };
} catch { /* 读不到就用默认 */ }
const AT = `@${WORKER.shortName}`;
console.log(`点名的成员：${WORKER.id}（${AT}）\n`);

sock.on("joinGroup", () => {});
await new Promise((r) => { sock.emit("joinGroup", { groupId: GID }); sock.once("joinedGroup", r); });

// 事件采集：delta（流式）/ tool/call（工具调用）在整轮里累计
let deltas = [];
let toolCalls = [];
sock.on("agentEvent", (ev) => {
  if (!inGroup(ev)) return;
  if (ev.type === "delta") deltas.push(String(ev.data?.text || ""));
  if (ev.type === "tool/call") toolCalls.push(String(ev.data?.name || ""));
});
/** 发一条消息并等这个成员的最终回复（同时把这一轮的流式/工具事件清零） */
async function sendAndWaitForReply(text, waitMs = TASK_TIMEOUT) {
  deltas = []; toolCalls = [];
  const ack = await emit("send", { groupId: GID, text });
  if (!ack?.ok) throw new Error(`发送失败：${ack?.error || JSON.stringify(ack)}`);
  return waitEv("message", fromBe, waitMs);
}
const resetProbe = (name) => { if (existsSync(name)) rmSync(name, { force: true }); };

// 兜底清理：任何一步抛错（等事件超时、断言中断）都必须先把临时工作区删掉再退出。
// 否则脚本中途失败会直接退出，把「🧪 验收-xxx」连同里面的失败气泡永久留在真人侧边栏里
// （踩过：调试期间脚本报错退出，侧边栏留下 3 个满是「执行失败」的残留工作区）。
let cleanedUp = false;
const cleanupTmpGroup = async () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    resetProbe(join(SANDBOX, "live-check.txt"));
    resetProbe(join(SANDBOX, "live-probe.txt"));
  } catch { /* 探针文件清理失败不影响工作区清理 */ }
  try {
    await emit("deleteGroup", { groupId: GID });
  } catch (e) {
    console.warn(`!! 临时工作区未能删除，请手动清理 ${GID}：${e?.message || e}`);
  }
};
const bailOut = (e) => {
  console.error(`\n未捕获异常（${e?.message || e}）—— 先清理临时工作区再退出`);
  cleanupTmpGroup().finally(() => { try { sock.disconnect(); } catch {} process.exit(1); });
};
process.on("unhandledRejection", bailOut);
process.on("uncaughtException", bailOut);

// ---------------- 1) 普通对话：流式 + 工具 + 产物 ----------------
if (ONLY.has("1")) {
  console.log("[1] 普通对话（流式打字机 + 工具调用 + 产物落盘）");
  const target = join(SANDBOX, "live-check.txt");
  resetProbe(target);
  const t0 = Date.now();
  const reply = await sendAndWaitForReply(
    `${AT} ${uniq()}在当前目录创建文件 live-check.txt，内容写 hello-live，然后读回来确认写入成功。`
  );
  const dt = Date.now() - t0;
  ok("收到成员最终回复", !!reply?.text?.trim(), `${dt}ms 「${head(reply?.text, 80)}」`);
  ok("流式 delta 事件已推送（打字机可用）", deltas.length > 0, `delta 条数=${deltas.length} 累计=${head(deltas.join(""), 60)}`);
  ok("工具调用事件已推送（思考过程可见）", toolCalls.length > 0, `工具=[${[...new Set(toolCalls)].join(", ")}]`);
  ok("回复带思考过程 trace", Array.isArray(reply?.trace) && reply.trace.length > 0, `trace 条数=${reply?.trace?.length || 0}`);
  ok("产物文件真的落盘且内容正确", existsSync(target) && /hello-live/.test(readFileSync(target, "utf8")), target);
}

// ---------------- 2) 审批闸门：拒绝 ----------------
if (ONLY.has("2")) {
  console.log("\n[2] 审批闸门（危险命令 → 挂起 → 拒绝）");
  const victim = join(SANDBOX, "live-approval-probe");
  resetProbe(victim);
  const apP = waitEv("approval", inGroup);
  const ack = await emit("send", {
    groupId: GID,
    text: `${AT} ${uniq()}执行这条 shell 命令并汇报结果：rm -rf ./live-approval-probe\n（只调用一次 run_shell，不要做别的事）`,
  });
  if (!ack?.ok) throw new Error(`发送失败：${ack?.error}`);
  const ap = await apP;
  ok("危险命令触发审批卡（工作区收到 approval 事件）", !!ap?.id, `agent=${ap?.agentName} ruleId=${ap?.request?.ruleId}`);
  ok("命中递归删除规则 rm-recursive", ap?.request?.ruleId === "rm-recursive", `ruleId=${ap?.request?.ruleId} 风险=${ap?.request?.risk}`);
  ok("审批卡带回命令原文供真人确认", /live-approval-probe/.test(String(ap?.request?.command || "")), head(ap?.request?.command, 60));
  ok("审批卡带超时倒计时", !!ap?.expiresAt, `expiresAt=${ap?.expiresAt}`);

  const resolved = waitEv("approvalResolved", (p) => inGroup(p) && p?.id === ap.id);
  const r = await emit("resolveApproval", { groupId: GID, id: ap.id, approved: false, note: "验收：拒绝" });
  ok("resolveApproval 受理（未报错）", r?.ok !== false, JSON.stringify(r || {}).slice(0, 80));
  await resolved;
  ok("前端会收到 approvalResolved（审批卡收起）", true);
  const reply = await waitEv("message", fromBe);
  ok("拒绝后任务正常收敛（有回复）", !!reply?.text?.trim(), `「${head(reply?.text, 90)}」`);
  ok("回复明确告知命令未执行", /未执行|未批准|被拒|拒绝/.test(reply?.text || ""), head(reply?.text, 100));
  ok("危险命令确实没有跑（目标路径不存在）", !existsSync(victim), victim);
}

// ---------------- 3) 审批闸门：批准 → 真正执行 ----------------
if (ONLY.has("3")) {
  console.log("\n[3] 审批闸门（挂起 → 批准 → 命令真正执行）");
  const produced = join(SANDBOX, "live-probe.txt");
  resetProbe(produced);
  const apP = waitEv("approval", inGroup);
  const ack = await emit("send", {
    groupId: GID,
    text: `${AT} ${uniq()}执行这条 shell 命令并汇报 shell 输出：printf 'live-ok' > ./live-probe.txt && rm -rf ./nothing-here\n（只调用一次 run_shell）`,
  });
  if (!ack?.ok) throw new Error(`发送失败：${ack?.error}`);
  const ap = await apP;
  ok("复合命令里的 rm -rf 也被识别（挂起）", !!ap?.id, `ruleId=${ap?.request?.ruleId}`);

  const resolved = waitEv("approvalResolved", (p) => inGroup(p) && p?.id === ap.id);
  await emit("resolveApproval", { groupId: GID, id: ap.id, approved: true, note: "验收：批准" });
  await resolved;
  const reply = await waitEv("message", fromBe, TASK_TIMEOUT);
  ok("批准后任务跑完（有回复）", !!reply?.text?.trim(), `「${head(reply?.text, 90)}」`);
  ok("命令被真正执行（产物文件已生成）", existsSync(produced), produced);
}

// ---------------- 4) 长期记忆 ----------------
if (ONLY.has("4")) {
  console.log("\n[4] 长期记忆 remember / recall");
  const FACT = "验收专用口径：上线前必须先跑离线单测再跑端到端验证";
  const reply1 = await sendAndWaitForReply(
    `${AT} ${uniq()}把这条事实写入长期记忆，key 用「验收口径」，内容原文照抄：${FACT}\n（只调用一次 remember 工具）`
  );
  ok("remember 调用完成", !!reply1?.text?.trim(), `工具=[${[...new Set(toolCalls)].join(", ")}]`);
  ok("调用的确实是 remember 工具", toolCalls.includes("remember"), `工具=[${[...new Set(toolCalls)].join(", ")}]`);

  let rows = [];
  try {
    const db = new DatabaseSync(MEMORY_DB, { readOnly: true });
    rows = db.prepare("SELECT namespace, key, value FROM long_term_memory").all();
    db.close();
  } catch (e) {
    console.log(`    （直查记忆库失败，跳过库断言：${e.message}）`);
  }
  if (rows.length || existsSync(MEMORY_DB)) {
    const mine = rows.filter((r) => String(r.namespace).includes(GID));
    ok("长期记忆库里确有本工作区的条目", mine.length > 0, `本区条数=${mine.length} / 全库=${rows.length}`);
    ok("落库内容与原文一致", mine.some((r) => String(r.value).includes("离线单测")), head(mine.map((r) => r.value).join(" | "), 90));
  }

  const reply2 = await sendAndWaitForReply(
    `${AT} ${uniq()}用 recall 工具查长期记忆里的「验收口径」，把查到的结论复述出来。`
  );
  ok("recall 能读回该事实", /离线单测/.test(reply2?.text || ""), `「${head(reply2?.text, 100)}」`);
}

// ---------------- 5) 设置项：备用模型 / 安全审批 ----------------
if (ONLY.has("5")) {
  console.log("\n[5] 设置项（备用模型 + 安全审批）存取");
  const disk = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
  const cur = disk();
  const model = cur.llm?.model || "deepseek-v4-flash";

  // 备用模型
  const a1 = await emit("updateSettings", { fallbackModel: model });
  ok("备用模型保存成功", a1?.ok === true, JSON.stringify(a1 || {}).slice(0, 80));
  const s1 = await waitEv("settings", (s) => s?.fallbackModel === model, 10_000);
  ok("广播里带回备用模型（UI 能回填）", s1.fallbackModel === model, `fallbackModel=${s1.fallbackModel}`);
  ok("settings.json 落盘 llm.fallback.model", disk().llm?.fallback?.model === model, JSON.stringify(disk().llm?.fallback || {}));

  // 审批开关 + 超时
  const a2 = await emit("updateSettings", { approvalEnabled: false, approvalTimeout: 120_000 });
  ok("审批开关保存成功", a2?.ok === true, JSON.stringify(a2 || {}).slice(0, 80));
  const s2 = await waitEv("settings", (s) => s?.approval?.enabled === false, 10_000);
  ok("广播里带回审批开关与超时", s2.approval?.enabled === false, `enabled=${s2.approval?.enabled} timeoutMs=${s2.approval?.timeoutMs}`);

  // 自定义正则：合法 / 非法
  const a3 = await emit("updateSettings", { approvalExtraPatterns: "^kubectl\\s+delete\\b" });
  ok("合法自定义正则被接受", a3?.ok === true, JSON.stringify(a3 || {}).slice(0, 80));
  const a4 = await emit("updateSettings", { approvalExtraPatterns: "^kubectl(delete" });
  ok("非法正则被拒绝并给中文提示", a4?.ok === false && /正则/.test(String(a4?.error || "")), `error=${a4?.error}`);

  // 复位
  const a5 = await emit("updateSettings", {
    fallbackModel: "",
    approvalEnabled: true,
    approvalTimeout: null,
    approvalExtraPatterns: "",
  });
  ok("复位成功（备用模型清空 / 审批恢复默认）", a5?.ok === true, JSON.stringify(a5 || {}).slice(0, 80));
  await waitEv("settings", (s) => s?.fallbackModel === "" && s?.approval?.enabled === true, 10_000);
  const back = disk();
  ok("落盘已复位", !back.llm?.fallback?.model && back.approval?.enabled !== false, JSON.stringify({ fallback: back.llm?.fallback || null, approval: back.approval }));
}

// ---------------- 收尾 ----------------
await cleanupTmpGroup();
console.log(`\n已删除临时工作区 ${GID}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
sock.disconnect();
process.exit(fail === 0 ? 0 : 1);
