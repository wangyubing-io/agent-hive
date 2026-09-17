// E2E: 群 ↔ 真实工作目录绑定
// 验证点:
//  1) updateGroup 配 workspace（目录存在）→ 广播 + 落盘
//  2) 不存在的目录被拒绝；空串清空回沙箱
//  3) @小满 在工作区写文件（真实 LLM）→ 文件落工作区 + 群文件区条目 baseDir=workspace + 下载 200 + 沙箱无泄漏
//  4) 下载内容与磁盘一致
//  5) 清理
import { io } from "socket.io-client";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

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

const fileEvents = [];
sock.on("file", (f) => fileEvents.push(f));
await new Promise((r) => sock.on("connect", r));

// 准备工作目录
const WS = resolve(join(DATA, "ws-e2e"));
mkdirSync(WS, { recursive: true });

// 1) 建群 + 配 workspace
const cg = await new Promise((r) => sock.emit("createGroup", { name: "工作区测试群" }, r));
if (!cg?.ok || !cg?.group?.id) fail("createGroup 失败");
const gid = cg.group.id;
const wsAck = await new Promise((r) => sock.emit("updateGroup", { groupId: gid, workspace: WS }, r));
if (!wsAck?.ok) fail("updateGroup workspace 失败", JSON.stringify(wsAck));
const gEv = await waitEv("groups", (l) => Array.isArray(l) && l.find((g) => g.id === gid)?.workspace === WS);
ok(`workspace 绑定成功: ${WS}`);
const groupsDisk = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
if (groupsDisk.find((g) => g.id === gid)?.workspace !== WS) fail("groups.json 未落盘 workspace");
ok("groups.json 落盘 ✓");

// 2) 不存在目录拒绝 + 空串清空
const bad = await new Promise((r) => sock.emit("updateGroup", { groupId: gid, workspace: "D:/definitely/not/exist/xyz" }, r));
if (bad?.ok !== false) fail("不存在目录应被拒");
ok("不存在目录被拒绝 ✓");
const clr = await new Promise((r) => sock.emit("updateGroup", { groupId: gid, workspace: "" }, r));
if (!clr?.ok) fail("清空 workspace 失败");
const gEv2 = await waitEv("groups", (l) => Array.isArray(l) && l.find((g) => g.id === gid)?.workspace === undefined);
ok("空串清空 workspace（回沙箱）✓");
// 重新绑上，做 3)
const reAck = await new Promise((r) => sock.emit("updateGroup", { groupId: gid, workspace: WS }, r));
if (!reAck?.ok) fail("重新绑定失败");
await waitEv("groups", (l) => Array.isArray(l) && l.find((g) => g.id === gid)?.workspace === WS);
sock.emit("joinGroup", { groupId: gid });
await sleep(300);

// 3) @小满 在工作区写文件（真实 LLM 一轮）
const fname = `ws-e2e-${Date.now().toString(36)}.md`;
const tSend = Date.now();
sock.emit("send", { groupId: gid, text: `@小满 请在当前工作目录创建文件 ${fname}，内容为一行：workspace-ok` });
const fileEv = await waitEv("file", (f) => f.groupId === gid && f.name === fname, 240000);
ok(`群文件区收到产物: ${fileEv.name}（baseDir=${fileEv.baseDir === WS ? "workspace ✓" : fileEv.baseDir}）`);
if (fileEv.baseDir !== WS) fail("条目 baseDir 应为工作区");
if (!existsSync(join(WS, fname))) fail("文件未落在工作区");
ok("文件落在真实工作区 ✓");
if (existsSync(join(DATA, "sandbox", "ai-qa", fname))) fail("沙箱不应出现该文件");
ok("各自沙箱无泄漏 ✓");
await waitEv("message", (m) => m.groupId === gid && m.senderId === "ai-qa" && m.ts > tSend && m.text, 240000);
ok("小满回复到达");

// 4) 下载内容与磁盘一致
const dl = await fetch(`${URL}/api/files/${fileEv.id}/download`);
if (dl.status !== 200) fail(`下载应 200，实际 ${dl.status}`);
const text = await dl.text();
const disk = readFileSync(join(WS, fname), "utf8");
if (text !== disk) fail("下载内容与磁盘不一致");
ok(`下载 200 内容一致（${text.length} 字符）✓`);

// 5) 清理
rmSync(WS, { recursive: true, force: true });
const groups2 = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
writeFileSync(join(DATA, "groups.json"), JSON.stringify(groups2.filter((g) => g.id !== gid), null, 2));
try { writeFileSync(join(DATA, "files", `${gid}.json`), JSON.stringify([])); } catch {}
ok("工作目录与测试群已清理");

console.log(`\nWORKSPACE-OK（${step} 步全部通过）`);
sock.disconnect();
process.exit(0);
