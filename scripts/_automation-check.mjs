// E2E: 定时任务（自动化）全链路
// 验证点:
//  1) createAutomation（每 1 分钟 @小满）→ ack + automations.json 落盘
//  2) listAutomations 返回该任务
//  3) 等调度器触发（30s tick + 1min 周期，lastRun=0 立即到期）→ 「⏰ 定时任务」消息 + 小满回复到达
//  4) 非法参数被拒（无周期 / 群不存在）
//  5) deleteAutomation → 再等一个周期不触发
import { io } from "socket.io-client";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL = "http://127.0.0.1:18741";
const DATA = join(process.cwd(), "data");
let step = 0;
const ok = (name) => console.log(`  ✓ [${++step}] ${name}`);
const fail = (name, extra) => { console.error(`  ✗ [${step + 1}] ${name} ${extra || ""}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sock = io(URL, { transports: ["websocket"] });
const waitEvOn = (ev, pred, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error(`等 ${ev} 超时`)); }, timeout);
    const h = (payload) => { try { if (!pred || pred(payload)) { clearTimeout(t); sock.off(ev, h); resolve(payload); } } catch {} };
    sock.on(ev, h);
  });
await new Promise((r) => sock.on("connect", r));

// 建测试群
const cg = await new Promise((r) => sock.emit("createGroup", { name: "定时任务测试群" }, r));
if (!cg?.ok || !cg?.group?.id) fail("createGroup 失败");
const gid = cg.group.id;
sock.emit("joinGroup", { groupId: gid });
await sleep(300);

// 4) 非法参数先测
const bad1 = await new Promise((r) => sock.emit("createAutomation", { groupId: gid, text: "x" }, r)); // 无周期
if (bad1?.ok !== false) fail("无周期应被拒");
ok("无周期被拒 ✓");
const bad2 = await new Promise((r) => sock.emit("createAutomation", { groupId: "g-none", text: "x", everyMin: 1 }, r));
if (bad2?.ok !== false) fail("群不存在应被拒");
ok("群不存在被拒 ✓");

// 1) 创建（everyMin=1，lastRun=0 → 下个 tick 立即到期）
const tCreate = Date.now();
const cr = await new Promise((r) => sock.emit("createAutomation", { groupId: gid, agentId: "ai-qa", everyMin: 1, text: "请只回复两个字：准点" }, r));
if (!cr?.ok || !cr?.automation?.id) fail("createAutomation 失败", JSON.stringify(cr));
const autoId = cr.automation.id;
ok(`定时任务创建（每 1 分钟 @小满）: ${autoId}`);
const disk = JSON.parse(readFileSync(join(DATA, "automations.json"), "utf8"));
if (!disk.find((a) => a.id === autoId)) fail("automations.json 未落盘");
ok("automations.json 落盘 ✓");

// 2) 列表
const li = await new Promise((r) => sock.emit("listAutomations", { groupId: gid }, r));
if (!li?.ok || !li.list?.find((a) => a.id === autoId)) fail("listAutomations 缺任务");
ok("listAutomations 返回任务 ✓");

// 3) 等触发（tick 30s + 消息路由 + LLM 回复）
console.log("    等待调度器触发（最长 ~120s）…");
const autoMsg = await waitEvOn("message", (m) => m.groupId === gid && m.senderId === "automation" && m.ts > tCreate, 150000);
if (!autoMsg.text.includes("@小满") || !autoMsg.text.includes("准点")) fail(`定时消息内容异常: ${autoMsg.text}`);
ok(`⏰ 定时任务消息入群: "${autoMsg.text.slice(0, 40)}"`);
const reply = await waitEvOn("message", (m) => m.groupId === gid && m.senderId === "ai-qa" && m.ts > autoMsg.ts && m.text, 240000);
console.log(`    小满回复: ${reply.text.slice(0, 50).replace(/\n/g, " ")}`);
ok("小满被定时任务触发并回复 ✓");

// 5) 删除 → 等一个周期确认不再触发
const del = await new Promise((r) => sock.emit("deleteAutomation", { id: autoId }, r));
if (!del?.ok) fail("deleteAutomation 失败");
ok("任务已删除");
const tDel = Date.now();
await sleep(75_000); // 一个周期 + tick 余量
const hist = readFileSync(join(DATA, "messages", `${gid}.jsonl`), "utf8");
const autoAfter = hist.trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.senderId === "automation" && m.ts > tDel);
if (autoAfter.length > 0) fail(`删除后仍触发 ${autoAfter.length} 次`);
ok("删除后不再触发（观察 75s）✓");

// 清理
const groups = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
writeFileSync(join(DATA, "groups.json"), JSON.stringify(groups.filter((g) => g.id !== gid), null, 2));
ok("测试群已清理");

console.log(`\nAUTOMATION-OK（${step} 步全部通过）`);
sock.disconnect();
process.exit(0);
