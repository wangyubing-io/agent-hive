// E2E: 群管理闭环（改名/描述/删群）+ 文件预览 + 聊天记录导出
// 验证点:
//  1) createGroup → updateGroup 改名/描述 → groups 广播 + 落盘
//  2) updateGroup 空群名被拒
//  3) 文件预览：文本类型 200 内容正确；不存在 404(JSON)；不支持类型被拒
//  4) 导出：/api/groups/g-dev/export.md → 200 markdown，含群名与最新一条消息的发送者
//  5) deleteGroup：g-dev 拒删；测试群删除 → groups 广播移除 + 磁盘 jsonl 保留
//  6) 清理
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
await new Promise((r) => sock.on("connect", r));
sock.emit("joinGroup", { groupId: "g-dev" });
await sleep(300);

// 1) 建群 + 改名/描述
const cg = await new Promise((r) => sock.emit("createGroup", { name: "群管理测试群" }, r));
if (!cg?.ok || !cg?.group?.id) fail("createGroup 失败");
const gid = cg.group.id;
const ugAck = await new Promise((r) => sock.emit("updateGroup", { groupId: gid, name: "群管理测试群V2", desc: "改过名的测试群" }, r));
if (!ugAck?.ok) fail("updateGroup ack 失败", JSON.stringify(ugAck));
const gEv = await waitEv("groups", (l) => Array.isArray(l) && l.find((g) => g.id === gid)?.name === "群管理测试群V2");
const g2 = gEv.find((g) => g.id === gid);
if (g2.desc !== "改过名的测试群") fail("描述未更新");
ok("updateGroup 改名/描述 → 广播 ✓");
const groupsDisk = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
const gd = groupsDisk.find((g) => g.id === gid);
if (!gd || gd.name !== "群管理测试群V2" || gd.desc !== "改过名的测试群") fail("groups.json 未落盘");
ok("groups.json 落盘 ✓");

// 2) 空群名被拒
const bad = await new Promise((r) => sock.emit("updateGroup", { groupId: gid, name: "   " }, r));
if (bad?.ok !== false) fail("空群名应被拒");
ok("空群名被拒 ✓");

// 3) 文件预览（塞条目指向真实沙箱文件）
const realPath = join(DATA, "sandbox", "ai-qa", "qa-concurrent.txt");
const fid = "f_pvtest1";
const fp = join(DATA, "files", `${gid}.json`);
writeFileSync(fp, JSON.stringify([{
  id: fid, groupId: gid, agentId: "ai-qa", agentName: "测试工程师", agentShortName: "小满",
  path: "qa-concurrent.txt", name: "qa-concurrent.txt", size: 100, ts: Date.now(),
}]));
const pv = await (await fetch(`${URL}/api/files/${fid}/preview`)).json();
if (!pv?.ok || typeof pv.text !== "string" || pv.text.length === 0) fail("预览应返回文本内容", JSON.stringify(pv).slice(0, 100));
ok(`文本预览 200（${pv.text.length} 字符）✓`);
const pv404 = await (await fetch(`${URL}/api/files/f_nosuch/preview`)).json();
if (pv404?.ok !== false) fail("不存在文件预览应 ok:false");
ok("不存在文件预览 → ok:false ✓");
// 不支持类型：造一个真实的二进制文件（预览按真实路径扩展名判定）
writeFileSync(join(DATA, "sandbox", "ai-qa", "fake-bin.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]));
writeFileSync(fp, JSON.stringify([{
  id: "f_pvtest2", groupId: gid, agentId: "ai-qa", agentName: "测试工程师", agentShortName: "小满",
  path: "fake-bin.png", name: "fake-bin.png", size: 12, ts: Date.now(),
}]));
const pvBin = await (await fetch(`${URL}/api/files/f_pvtest2/preview`)).json();
if (pvBin?.ok !== false) fail("二进制类型预览应被拒");
ok("不支持类型（.png）预览被拒 ✓");

// 4) 导出聊天记录（g-dev）
const ex = await fetch(`${URL}/api/groups/g-dev/export.md`);
if (ex.status !== 200) fail(`导出应 200，实际 ${ex.status}`);
const md = await ex.text();
if (!md.includes("# ") || !md.includes("聊天记录")) fail("导出缺标题");
const hist = readFileSync(join(DATA, "messages", "g-dev.jsonl"), "utf8").trim().split("\n");
const last = JSON.parse(hist[hist.length - 1]);
if (!md.includes(last.senderName)) fail("导出未包含最新消息发送者");
if (!md.includes(last.text.slice(0, 20))) fail("导出未包含最新消息内容");
ok(`导出 markdown（${md.length} 字符，含最新消息）✓`);
const cd = ex.headers.get("content-disposition") || "";
if (!cd.includes("attachment")) fail("导出应带 attachment 头");
ok("导出带 attachment 下载头 ✓");

// 5) 删群
const delDefault = await new Promise((r) => sock.emit("deleteGroup", { groupId: "g-dev" }, r));
if (delDefault?.ok !== false) fail("g-dev 应拒删");
ok("g-dev 拒删 ✓");
// 群里先发一条消息，验证删除后 jsonl 保留
sock.emit("send", { groupId: gid, text: "删除前的最后一条消息" });
await sleep(800);
const delAck = await new Promise((r) => sock.emit("deleteGroup", { groupId: gid }, r));
if (!delAck?.ok) fail("deleteGroup 失败", JSON.stringify(delAck));
await waitEv("groups", (l) => Array.isArray(l) && !l.find((g) => g.id === gid));
ok("deleteGroup → groups 广播移除 ✓");
if (!existsSync(join(DATA, "messages", `${gid}.jsonl`))) fail("删除后消息 jsonl 应保留");
const kept = readFileSync(join(DATA, "messages", `${gid}.jsonl`), "utf8");
if (!kept.includes("删除前的最后一条消息")) fail("保留的 jsonl 缺内容");
ok("磁盘消息 jsonl 保留（可找回）✓");

// 6) 清理孤儿文件条目
writeFileSync(fp, JSON.stringify([]));
ok("测试文件条目已清理");

console.log(`\nGROUP-MGMT-OK（${step} 步全部通过）`);
sock.disconnect();
process.exit(0);
