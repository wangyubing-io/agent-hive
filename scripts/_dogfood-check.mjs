// E2E: 狗粮终验 —— AI 团队在 agent-hive 源码副本上完成真实小需求
// 链路：复制源码副本 → 建群绑定 workspace → @老何 实现 scripts/count-lines.mjs 并自验 →
//       断言产物落副本目录 + file 条目归属/路径正确 + 产物内容合理 → 清理
import { io } from "socket.io-client";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const URL = "http://127.0.0.1:18741";
const DATA = join(process.cwd(), "data");
let step = 0;
const ok = (name) => console.log(`  ✓ [${++step}] ${name}`);
const fail = (name, extra) => { console.error(`  ✗ [${step + 1}] ${name} ${extra || ""}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitEvOn = (sock, ev, pred, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error(`等 ${ev} 超时`)); }, timeout);
    const h = (payload) => { try { if (!pred || pred(payload)) { clearTimeout(t); sock.off(ev, h); resolve(payload); } } catch {} };
    sock.on(ev, h);
  });

const WS = resolve(join(DATA, "dogfood"));
if (!existsSync(join(WS, "package.json"))) fail("dogfood 副本不存在（先跑复制步骤）");

const sock = io(URL, { transports: ["websocket"] });
await new Promise((r) => sock.on("connect", r));

// 建群 + 绑定 workspace
const cg = await new Promise((r) => sock.emit("createGroup", { name: "狗粮验证群" }, r));
if (!cg?.ok || !cg?.group?.id) fail("createGroup 失败");
const gid = cg.group.id;
const wsAck = await new Promise((r) => sock.emit("updateGroup", { groupId: gid, workspace: WS }, r));
if (!wsAck?.ok) fail("workspace 绑定失败");
sock.emit("joinGroup", { groupId: gid });
await sleep(300);

const fileEvents = [];
sock.on("file", (f) => { if (f.groupId === gid) fileEvents.push(f); });

// 真实需求：在项目里加统计脚本并自验
const tSend = Date.now();
sock.emit("send", {
  groupId: gid,
  text: "@老何 请在这个项目里新增 scripts/count-lines.mjs：递归统计 packages/ 和 apps/ 下 .ts/.js 文件的总行数与文件数，按顶层目录汇总输出（排除 node_modules）。写完用 node scripts/count-lines.mjs 跑一遍验证，把运行结果贴出来。",
});

const reply = await waitEvOn(sock, "message", (m) => m.groupId === gid && m.senderId === "ai-be" && m.ts > tSend && m.text, 360000);
console.log(`    老何回复（节选）: ${reply.text.slice(0, 120).replace(/\n/g, " / ")}`);
ok("老何完成需求并汇报");

// 断言产物
const scriptPath = join(WS, "scripts", "count-lines.mjs");
if (!existsSync(scriptPath)) fail(`产物未落在副本: ${scriptPath}（file events: ${fileEvents.map((f) => f.name).join(",")}）`);
ok("产物落在真实项目副本 scripts/count-lines.mjs ✓");
const entry = fileEvents.find((f) => f.name === "count-lines.mjs");
if (!entry) fail("群文件区缺产物条目");
if (entry.baseDir !== WS) fail(`条目 baseDir 错误: ${entry.baseDir}`);
if (entry.agentId !== "ai-be" && entry.agentId !== "team") fail(`条目归属异常: ${entry.agentId}`);
ok(`群文件区条目: 路径=${entry.path} 归属=${entry.agentShortName} ✓`);

// 产物内容合理性
const code = readFileSync(scriptPath, "utf8");
if (!/packages/.test(code) || !/apps/.test(code)) fail("产物内容缺 packages/apps 逻辑");
if (code.length < 200) fail("产物过短，疑似敷衍");
ok(`产物内容合理（${code.length} 字符，含 packages/apps 统计逻辑）✓`);

// 下载链路
const dl = await fetch(`${URL}/api/files/${entry.id}/download`);
if (dl.status !== 200) fail(`下载应 200，实际 ${dl.status}`);
const dlText = await dl.text();
if (dlText !== code) fail("下载内容与磁盘不一致");
ok("产物下载 200 内容一致 ✓");

// 清理
rmSync(WS, { recursive: true, force: true });
const groups = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
writeFileSync(join(DATA, "groups.json"), JSON.stringify(groups.filter((g) => g.id !== gid), null, 2));
try { writeFileSync(join(DATA, "files", `${gid}.json`), JSON.stringify([])); } catch {}
try { rmSync(join(DATA, "orchestrations", `${gid}.jsonl`), { force: true }); } catch {}
ok("现场已清理（副本 + 测试群）");

console.log(`\nDOGFOOD-OK（${step} 步全部通过）`);
sock.disconnect();
process.exit(0);
