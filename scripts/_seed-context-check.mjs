// E2E: 会话种子注入 —— 重置会话后 agent 仍能通过注入的群聊摘要回答历史问题
// 流程：发一条独特署名消息 → resetSession（会话清空+种子清空）→ @小满 问「最近一条消息是谁发的」
//       → 断言回复包含期望发送者（若种子未注入，全新会话只知道当前问题，答不出历史）
import { io } from "socket.io-client";

const URL = "http://127.0.0.1:18741";
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

// 独立测试群（保证历史干净可控）
const cg = await new Promise((r) => sock.emit("createGroup", { name: "种子注入测试群" }, r));
if (!cg?.ok || !cg?.group?.id) fail("createGroup 失败");
const gid = cg.group.id;
sock.emit("joinGroup", { groupId: gid });
await sleep(300);

// 1) 铺一条独特历史消息（含独特暗号，作为「历史锚点」）
sock.emit("send", { groupId: gid, text: "项目代号确定为「北极星九号」，明天开工。" });
await sleep(1500); // 消息落盘（无需 agent 处理：文本不含 @ 且以非问候开头会触发 lead 编排！）
// 修正：上面消息会触发王大锤编排（几分钟后回复会进来，不影响本测试断言，忽略即可）

// 2) 重置小满会话（清空记忆 + 清种子标记）
const rs = await new Promise((r) => sock.emit("resetSession", { agentId: "ai-qa" }, r));
if (!rs?.ok) fail("resetSession 失败");
ok("小满会话已重置（记忆清空）");

// 3) 问历史问题（新会话 + 种子注入 → 应能答出暗号）
const tQ = Date.now();
sock.emit("send", { groupId: gid, text: "@小满 我们群里的项目代号是什么？只回答代号本身。" });
const reply = await waitEvOn("message", (m) => m.groupId === gid && m.senderId === "ai-qa" && m.ts > tQ && m.text, 240000);
console.log(`    小满回答: ${reply.text.slice(0, 80).replace(/\n/g, " ")}`);
if (!reply.text.includes("北极星九号")) fail("种子注入未生效：小满答不出历史暗号", `回复="${reply.text.slice(0, 100)}"`);
ok("种子注入生效：重置后仍答出「北极星九号」✓");

// 清理
const { writeFileSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const DATA = join(process.cwd(), "data");
const groups = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
writeFileSync(join(DATA, "groups.json"), JSON.stringify(groups.filter((g) => g.id !== gid), null, 2));
ok("测试群已清理");

console.log(`\nSEED-CONTEXT-OK（${step} 步全部通过）`);
sock.disconnect();
process.exit(0);
