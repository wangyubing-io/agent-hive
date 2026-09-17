// E2E: 自定义成员 + 群成员定制
// 验证点:
//  1) createAgent → ack + agents 广播（builtin:false）+ 沙箱目录创建 + settings.json 落盘 + 加入所有群
//  2) @自定义成员 路由触发（数据驱动路由）→ 真实 LLM 回复
//  3) 内置成员 deleteAgent 被拒绝
//  4) createGroup → updateGroupMembers（只留小满）→ groups 广播 memberIds
//  5) 非成员 @ 被忽略（@小岚 不触发）+ 成员 @ 正常（@小满 回复）
//  6) deleteAgent → agents/groups 广播 + 群名单清理 + 落盘
//  7) 清理测试群
import { io } from "socket.io-client";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const URL = "http://127.0.0.1:18741";
const DATA = join(process.cwd(), "data");
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
const waitCond = async (pred, timeout) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (pred()) return true; await sleep(300); } return false; };

const typingEvents = [];
sock.on("typing", (ev) => typingEvents.push(ev));
await new Promise((r) => sock.on("connect", r));

// 1) createAgent
const caAck = await new Promise((r) =>
  sock.emit("createAgent", {
    role: "ops", shortName: "阿澈", name: "运维工程师", title: "SRE",
    avatar: "🛠️", color: "#8a6fc9", persona: "你是运维工程师阿澈，负责部署、环境与线上稳定性。",
  }, r));
if (!caAck?.ok || !caAck?.agent?.id) fail("createAgent ack 失败", JSON.stringify(caAck));
const newId_ = caAck.agent.id;
ok(`createAgent 阿澈 (${newId_})`);
const agentsEv = await waitEv("agents", (l) => Array.isArray(l) && l.find((a) => a.id === newId_));
const ache = agentsEv.find((a) => a.id === newId_);
if (ache.builtin !== false) fail("自定义成员应 builtin:false");
if (!existsSync(join(DATA, "sandbox", newId_))) fail("沙箱目录未创建");
const disk = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
if (!disk.agents.find((a) => a.id === newId_)) fail("settings.json 未落盘新成员");
const groupsDisk = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
if (!groupsDisk.find((g) => g.id === "g-dev")?.memberIds?.includes(newId_)) fail("新成员未加入 g-dev");
ok("agents 广播 builtin:false + 沙箱创建 + 落盘 + 加入所有群 ✓");

// 2) @自定义成员（真实 LLM 一轮）
sock.emit("joinGroup", { groupId: "g-dev" });
await sleep(300);
const tSend1 = Date.now();
typingEvents.length = 0;
sock.emit("send", { groupId: "g-dev", text: "@阿澈 请只回复两个字：就位" });
if (!(await waitCond(() => typingEvents.some((e) => e.agentId === newId_), 30000))) fail("@阿澈 未触发 typing");
ok("@阿澈（自定义成员）→ typing 触发（数据驱动路由）");
const reply1 = await waitEv("message", (m) => m.groupId === "g-dev" && m.senderId === newId_ && m.ts > tSend1 && m.text, 180000);
console.log(`    阿澈回复: ${reply1.text.slice(0, 60).replace(/\n/g, " ")}`);
ok("@阿澈 → 回复到达");

// 3) 内置成员删除被拒
const delBuiltin = await new Promise((r) => sock.emit("deleteAgent", { id: "ai-qa" }, r));
if (delBuiltin?.ok !== false) fail("内置成员删除应被拒绝");
ok("内置成员（小满）删除被拒绝 ✓");

// 4) 建群 + 定制成员（只留小满）
const cg = await new Promise((r) => sock.emit("createGroup", { name: "成员定制测试群" }, r));
if (!cg?.ok || !cg?.group?.id) fail("createGroup 失败");
const gid = cg.group.id;
const umAck = await new Promise((r) => sock.emit("updateGroupMembers", { groupId: gid, memberIds: ["ai-qa"] }, r));
if (!umAck?.ok) fail("updateGroupMembers 失败", JSON.stringify(umAck));
const gEv = await waitEv("groups", (l) => Array.isArray(l) && l.find((g) => g.id === gid)?.memberIds?.join(",") === "human,ai-qa");
ok(`群成员定制生效: [${gEv.find((g) => g.id === gid).memberIds.join(",")}]`);
// 空成员拒绝
const umBad = await new Promise((r) => sock.emit("updateGroupMembers", { groupId: gid, memberIds: [] }, r));
if (umBad?.ok !== false) fail("空成员列表应被拒绝");
ok("空成员列表被拒绝 ✓");

// 5a) 非成员 @ 被忽略（@小岚 不在小满群 → 无路由）
sock.emit("joinGroup", { groupId: gid });
await sleep(300);
typingEvents.length = 0;
sock.emit("send", { groupId: gid, text: "@小岚 @阿澈 你们在吗" });
await sleep(6000);
const leaked = typingEvents.filter((e) => e.groupId === gid);
if (leaked.length > 0) fail(`非成员被路由: ${JSON.stringify(leaked)}`);
ok("非群成员（@小岚/@阿澈）在本群不被路由 ✓");

// 5b) 成员 @ 正常（真实 LLM 一轮）
const tSend2 = Date.now();
sock.emit("send", { groupId: gid, text: "@小满 请只回复两个字：收到" });
if (!(await waitCond(() => typingEvents.some((e) => e.groupId === gid && e.agentId === "ai-qa"), 30000))) fail("@小满 在定制群未触发");
ok("群成员（@小满）正常路由 ✓");
const reply2 = await waitEv("message", (m) => m.groupId === gid && m.senderId === "ai-qa" && m.ts > tSend2 && m.text, 180000);
console.log(`    小满回复: ${reply2.text.slice(0, 60).replace(/\n/g, " ")}`);

// 6) deleteAgent 阿澈
const delAck = await new Promise((r) => sock.emit("deleteAgent", { id: newId_ }, r));
if (!delAck?.ok) fail("deleteAgent 失败");
await waitEv("agents", (l) => Array.isArray(l) && !l.find((a) => a.id === newId_));
const disk2 = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
if (disk2.agents.find((a) => a.id === newId_)) fail("删除后 settings.json 仍有阿澈");
const groupsDisk2 = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
if (groupsDisk2.find((g) => g.id === "g-dev")?.memberIds?.includes(newId_)) fail("删除后 g-dev memberIds 仍含阿澈");
ok("deleteAgent 阿澈 → 广播 + 落盘 + 群名单清理 ✓");

// 7) 清理测试群
const groupsPath = join(DATA, "groups.json");
const groups2 = JSON.parse(readFileSync(groupsPath, "utf8"));
writeFileSync(groupsPath, JSON.stringify(groups2.filter((g) => g.id !== gid), null, 2));
try { writeFileSync(join(DATA, "files", `${gid}.json`), JSON.stringify([])); } catch {}
ok("测试群已清理");

console.log(`\nCUSTOM-MEMBERS-OK（${step} 步全部通过）`);
sock.disconnect();
process.exit(0);
