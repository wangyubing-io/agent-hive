// E2E: 设置面板协议 + @ 路由修复 + 跨群文件下载
// 验证点:
//  1) 连接收到 settings 事件
//  2) updateSettings ack + 广播 + 落盘 data/settings.json
//  3) autoReply=false 时含「测试」字样的消息不再误触发 ai-qa（无 typing 事件）
//  4) updateAgent 修改 persona/rules → ack + agents 广播 + 落盘
//  5) @小满 显式点名正常触发（真实 LLM 一轮）
//  6) 跨群文件下载（非 g-dev 群的文件条目也能下载，修硬编码 bug）
import { io } from "socket.io-client";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const URL = "http://127.0.0.1:18741";
const ROOT = process.cwd();
const DATA = join(ROOT, "data");
let step = 0;
const ok = (name) => console.log(`  ✓ [${++step}] ${name}`);
const fail = (name, extra) => { console.error(`  ✗ [${step + 1}] ${name} ${extra || ""}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sock = io(URL, { transports: ["websocket"] });
const waitEv = (ev, pred, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error(`等 ${ev} 超时`)); }, timeout);
    const h = (payload) => { try { if (!pred || pred(payload)) { clearTimeout(t); sock.off(ev, h); resolve(payload); } } catch {} };
    sock.on(ev, h);
  });

const typingEvents = [];
sock.on("typing", (ev) => typingEvents.push(ev));

await new Promise((r) => sock.on("connect", r));

// 1) settings 事件
const s0 = await waitEv("settings", (s) => s && typeof s.autoReply === "boolean");
ok(`连接收到 settings: autoReply=${s0.autoReply} orchestrate=${s0.orchestrate} model=${s0.model}`);
if (s0.autoReply !== true) fail("初始 autoReply 应为 true");

// 2) updateSettings
const setAck = await new Promise((r) => sock.emit("updateSettings", { autoReply: false }, r));
if (!setAck?.ok) fail("updateSettings ack 失败");
await waitEv("settings", (s) => s.autoReply === false);
ok("updateSettings{autoReply:false} → ack ok + settings 广播");
const disk1 = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
if (disk1.autoReply !== false) fail("settings.json 未落盘 autoReply=false");
ok("settings.json 落盘 ✓");

// joinGroup
sock.emit("joinGroup", { groupId: "g-dev" });
await sleep(300);

// 3) 「测试」字样不误触发（autoReply=false → 无路由）
typingEvents.length = 0;
sock.emit("send", { groupId: "g-dev", text: "这条消息包含测试两个字，但不 @ 任何人，不应触发测试工程师" });
await sleep(6000);
if (typingEvents.length > 0) fail(`「测试」子串误触发: ${JSON.stringify(typingEvents)}`);
ok("含「测试」字样 + 无 @ → 不再误触发 ai-qa（修复前会触发）");

// 4) updateAgent
const agAck = await new Promise((r) =>
  sock.emit("updateAgent", { id: "ai-qa", persona: "你是测试工程师小满（E2E 验证版人设）。", rules: ["E2E规则A", "E2E规则B"] }, r));
if (!agAck?.ok) fail("updateAgent ack 失败");
const agentsEv = await waitEv("agents", (l) => Array.isArray(l) && l.find((a) => a.id === "ai-qa")?.persona?.includes("E2E 验证版"));
ok("updateAgent → ack ok + agents 广播（persona 已更新）");
const disk2 = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
const qaDisk = disk2.agents.find((a) => a.id === "ai-qa");
if (!qaDisk?.rules?.includes("E2E规则A")) fail("agents 未落盘");
ok("agent persona/rules 落盘 settings.json ✓");

// 5) @ 显式点名（真实 LLM 一轮）—— 同时并行做下载测试
// 注意 typing 在 send 后立即广播：先清空收集器再发送，用轮询判定避免监听竞态
const tSend = Date.now();
typingEvents.length = 0;
sock.emit("send", { groupId: "g-dev", text: "@小满 请只回复两个字：收到" });
const waitCond = async (pred, timeout) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (pred()) return true; await sleep(300); } return false; };

// 6) 跨群文件下载：正规建一个非 g-dev 群，往它的 files json 塞一条指向真实沙箱文件的条目
const cgAck = await new Promise((r) => sock.emit("createGroup", { name: "下载测试群" }, r));
if (!cgAck?.ok || !cgAck?.group?.id) fail("createGroup 失败");
const dlGroup = cgAck.group.id;
const realFile = join(DATA, "sandbox", "ai-qa", "qa-concurrent.txt");
const fakeId = "f_dltest123";
const filesPath = join(DATA, "files", `${dlGroup}.json`);
mkdirSync(join(DATA, "files"), { recursive: true });
writeFileSync(filesPath, JSON.stringify([{
  id: fakeId, groupId: dlGroup, agentId: "ai-qa", agentName: "测试工程师", agentShortName: "小满",
  path: "qa-concurrent.txt", name: "qa-concurrent.txt", size: 100, ts: Date.now(),
}]));
const dl = await fetch(`${URL}/api/files/${fakeId}/download`);
if (dl.status !== 200) fail(`跨群文件下载应 200，实际 ${dl.status}`);
const dlText = await dl.text();
ok(`非 g-dev 群文件下载 200（修复前 404），内容长度 ${dlText.length}`);
const nf = await fetch(`${URL}/api/files/f_nosuchfile/download`);
if (nf.status !== 404) fail(`不存在文件应 404，实际 ${nf.status}`);
ok("不存在文件 → 404 防护 ✓");
// 清理：删测试文件条目 + 从 groups.json 移除测试群
writeFileSync(filesPath, JSON.stringify([]));
const groupsPath = join(DATA, "groups.json");
const groups = JSON.parse(readFileSync(groupsPath, "utf8"));
writeFileSync(groupsPath, JSON.stringify(groups.filter((g) => g.id !== dlGroup), null, 2));

// 等 @小满 的真实回复
const t0 = Date.now();
if (!(await waitCond(() => typingEvents.some((e) => e.agentId === "ai-qa"), 30000))) fail("@小满 未触发 typing（30s）");
ok(`@小满 → typing 事件触发 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
const reply = await waitEv("message", (m) => m.groupId === "g-dev" && m.senderId === "ai-qa" && m.ts > tSend && m.text && m.text.length > 0, 180000);
console.log(`    小满回复: ${reply.text.slice(0, 80).replace(/\n/g, " ")}`);
ok("@小满 显式点名 → 正常执行并回复");

// 恢复 autoReply
const ack3 = await new Promise((r) => sock.emit("updateSettings", { autoReply: true }, r));
if (!ack3?.ok) fail("恢复 autoReply 失败");
await waitEv("settings", (s) => s.autoReply === true);
ok("autoReply 已恢复 true");

console.log(`\nSETTINGS-ROUTING-OK（${step} 步全部通过）`);
sock.disconnect();
process.exit(0);
