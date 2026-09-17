// E2E: 排队可见性 —— 连发两条 @小满，第二条应产生 queued 事件，随后两条回复先后到达
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

const cg = await new Promise((r) => sock.emit("createGroup", { name: "排队测试群" }, r));
if (!cg?.ok || !cg?.group?.id) fail("createGroup 失败");
const gid = cg.group.id;
sock.emit("joinGroup", { groupId: gid });
await sleep(300);

const queuedEvents = [];
sock.on("agentEvent", (ev) => { if (ev.groupId === gid && ev.type === "queued") queuedEvents.push(ev); });

// 连发两条 @小满：先等第一条真正开跑（首个执行事件 = runtime 已建立），第二条必然命中 busy 窗口
const t0 = Date.now();
sock.emit("send", { groupId: gid, text: "@小满 第一条：请只回复：一号完成" });
await waitEvOn("agentEvent", (e) => e.groupId === gid && e.agentId === "ai-qa" && /step\/start|tool\/call|assistant\/message/.test(e.type), 120000);
sock.emit("send", { groupId: gid, text: "@小满 第二条：请只回复：二号完成" });
ok("第一条开跑后发第二条 @小满");

// 断言 queued 事件（第二条排队提示）
if (!(await Promise.race([
  waitEvOn("agentEvent", (e) => e.groupId === gid && e.type === "queued", 30000).then(() => true),
  sleep(30000).then(() => false),
]))) fail("第二条任务未产生 queued 事件");
ok("第二条任务产生 queued 排队提示 ✓");

// 两条回复先后到达（串行链保证顺序）
const r1 = await waitEvOn("message", (m) => m.groupId === gid && m.senderId === "ai-qa" && m.ts > t0 && m.text, 300000);
const r2 = await waitEvOn("message", (m) => m.groupId === gid && m.senderId === "ai-qa" && m.ts > r1.ts && m.text, 300000);
console.log(`    回复1: ${r1.text.slice(0, 30).replace(/\n/g, " ")} | 回复2: ${r2.text.slice(0, 30).replace(/\n/g, " ")}`);
ok("两条回复先后到达（串行链顺序执行）✓");

// 清理
const groups = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
writeFileSync(join(DATA, "groups.json"), JSON.stringify(groups.filter((g) => g.id !== gid), null, 2));
ok("测试群已清理");

console.log(`\nQUEUE-VIS-OK（${step} 步全部通过）`);
sock.disconnect();
process.exit(0);
