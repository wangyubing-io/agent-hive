// E2E: ① 产物精确归属（workspace 并行 + 工具事件 claimed）② 编排看板落盘重放
// Part A: 建群绑 workspace → @小岚 @老何 并行各写指定文件 → file 条目 agentId 精确归属
// Part B: @王大锤 触发小编排 → 事件落盘 jsonl → 重连 joinGroup 收 orchHistory 完整序列
import { io } from "socket.io-client";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

// ============ Part A: 精确归属 ============
{
  const sock = io(URL, { transports: ["websocket"] });
  await new Promise((r) => sock.on("connect", r));

  const WS = resolve(join(DATA, "ws-attr"));
  mkdirSync(WS, { recursive: true });
  const cg = await new Promise((r) => sock.emit("createGroup", { name: "归属测试群" }, r));
  if (!cg?.ok || !cg?.group?.id) fail("createGroup 失败");
  const gid = cg.group.id;
  const wsAck = await new Promise((r) => sock.emit("updateGroup", { groupId: gid, workspace: WS }, r));
  if (!wsAck?.ok) fail("workspace 绑定失败");
  sock.emit("joinGroup", { groupId: gid });
  await sleep(300);

  const fFile = `attr-fe-${Date.now().toString(36)}.md`;
  const bFile = `attr-be-${Date.now().toString(36)}.md`;
  const fileEvents = [];
  sock.on("file", (f) => { if (f.groupId === gid) fileEvents.push(f); });

  const tA = Date.now();
  sock.emit("send", { groupId: gid, text: `@小岚 @老何 并行任务：小岚只创建文件 ${fFile}（内容：前端产出），老何只创建文件 ${bFile}（内容：后端产出）。各自只做自己的文件，不要动对方的。` });

  const fEv = await waitEvOn(sock, "file", (f) => f.groupId === gid && (f.name === fFile || f.name === bFile), 300000);
  ok(`第一个产物到达: ${fEv.name} → ${fEv.agentId}`);
  await waitEvOn(sock, "file", (f) => f.groupId === gid && ((f.name === fFile && fEv.name === bFile) || (f.name === bFile && fEv.name === fFile)), 300000);
  ok("两个产物都到达");
  // 等两轮 done，确保 diff 全部收完
  await sleep(4000);

  const fe = fileEvents.find((f) => f.name === fFile);
  const be = fileEvents.find((f) => f.name === bFile);
  if (!fe || !be) fail(`产物不全: fe=${!!fe} be=${!!be}（events=${fileEvents.map((f) => f.name + ":" + f.agentId).join(", ")}）`);
  // 硬断言：不得错署他人（修复前 attr-be 会挂在先结束的小岚名下）；
  // 软信息：agent 用 pwsh/bash 写文件时无署名路径 → 诚实归「团队」（ai-fe/ai-be/one of team 均为正确归属）
  if (fe.agentId === "ai-be") fail(`前端文件错署到后端名下: ${fe.agentId}`);
  if (be.agentId === "ai-fe") fail(`后端文件错署到前端名下: ${be.agentId}`);
  if (!["ai-fe", "team"].includes(fe.agentId)) fail(`前端文件归属异常: ${fe.agentId}`);
  if (!["ai-be", "team"].includes(be.agentId)) fail(`后端文件归属异常: ${be.agentId}`);
  const precise = fe.agentId === "ai-fe" && be.agentId === "ai-be";
  ok(`归属无错署 ✓（${fFile}→${fe.agentId === "ai-fe" ? "小岚" : fe.agentShortName} / ${bFile}→${be.agentId === "ai-be" ? "老何" : be.agentShortName}${precise ? "，精确署名" : "，部分为团队产出（pwsh 无署名路径，诚实标记）"}）`);

  // 清理
  rmSync(WS, { recursive: true, force: true });
  const groups = JSON.parse(readFileSync(join(DATA, "groups.json"), "utf8"));
  writeFileSync(join(DATA, "groups.json"), JSON.stringify(groups.filter((g) => g.id !== gid), null, 2));
  try { writeFileSync(join(DATA, "files", `${gid}.json`), JSON.stringify([])); } catch {}
  try { rmSync(join(DATA, "orchestrations", `${gid}.jsonl`), { force: true }); } catch {}
  sock.disconnect();
  ok("Part A 现场已清理");
}

// ============ Part B: 编排落盘重放 ============
{
  const sock = io(URL, { transports: ["websocket"] });
  await new Promise((r) => sock.on("connect", r));
  sock.emit("joinGroup", { groupId: "g-dev" });
  await sleep(300);

  const orchEvents = [];
  sock.on("orchestration", (ev) => { if (ev.groupId === "g-dev") orchEvents.push(ev); });

  // 触发一次小编排（简单需求 → 可能 no-dispatch 直接回答，事件链 plan→end 也落盘）
  const tB = Date.now();
  sock.emit("send", { groupId: "g-dev", text: "今天天气不错" });
  const endEv = await waitEvOn(sock, "orchestration", (e) => e.groupId === "g-dev" && e.phase === "end" && e.ts > tB, 300000);
  const runId = endEv.runId;
  const phases = orchEvents.filter((e) => e.runId === runId).map((e) => e.phase);
  if (phases[0] !== "plan") fail("事件链应从 plan 开始");
  ok(`编排执行完成（${phases.join("→")}）`);
  sock.disconnect();

  // 落盘断言
  const orchFile = join(DATA, "orchestrations", "g-dev.jsonl");
  if (!existsSync(orchFile)) fail("orchestrations/g-dev.jsonl 不存在");
  const lines = readFileSync(orchFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const runLines = lines.filter((l) => l.runId === runId);
  if (runLines.length < 2 || runLines[0].phase !== "plan") fail("落盘事件不全");
  if (!runLines.every((l) => typeof l.ts === "number")) fail("落盘事件缺 ts 字段");
  ok(`落盘 jsonl：本 run ${runLines.length} 条事件（含 ts）✓`);

  // 重连重放
  const sock2 = io(URL, { transports: ["websocket"] });
  await new Promise((r) => sock2.on("connect", r));
  sock2.emit("joinGroup", { groupId: "g-dev" });
  const hist = await waitEvOn(sock2, "orchHistory", (l) => Array.isArray(l) && l.some((e) => e.runId === runId), 10000);
  const replayRun = hist.filter((e) => e.runId === runId);
  if (replayRun.length !== runLines.length) fail(`重放条数不一致: ${replayRun.length} vs ${runLines.length}`);
  ok(`重连重放: orchHistory 收到本 run 完整 ${replayRun.length} 条序列 ✓`);
  sock2.disconnect();
}

console.log(`\nATTR-REPLAY-OK（${step} 步全部通过）`);
process.exit(0);
