// E2E: 会话重置（让 agent 忘掉之前）
// 验证点:
//  1) @小满 一轮真实对话（建立会话）→ 回复到达
//  2) resetSession → ack ok（quarantined ≥1）+ 群内 system 消息广播
//  3) ~/.dsh 下出现 ai-qa session 的 .stale-* 隔离目录
//  4) reset 后 @小满 仍可正常对话（全新会话不报 id collision）
import { io } from "socket.io-client";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const URL = "http://127.0.0.1:18741";
const DSH = join(homedir(), ".dsh");
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

/** 列出 .dsh 下 ai-qa 会话相关文件/目录（含 .stale 隔离） */
function qaSessionArtefacts() {
  const out = { live: 0, stale: 0 };
  try {
    for (const e of readdirSync(join(DSH, "sessions"), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      for (const f of readdirSync(join(DSH, "sessions", e.name))) {
        if (f.startsWith("ai-qa-")) out.live++;
        if (f.startsWith("ai-qa-") && f.includes(".stale-")) out.stale++;
      }
    }
  } catch { /* 目录可能不存在 */ }
  try {
    const cache = join(DSH, "storages", "session_projcache", "sessions");
    if (existsSync(cache)) {
      for (const f of readdirSync(cache)) {
        if (f.startsWith("ai-qa-")) out.live++;
        if (f.startsWith("ai-qa-") && f.includes(".stale-")) out.stale++;
      }
    }
  } catch { /* ignore */ }
  return out;
}

// 1) 建立会话（真实 LLM 一轮）
const t1 = Date.now();
sock.emit("send", { groupId: "g-dev", text: "@小满 请记住暗号「蓝鲸七号」，只回复：已记住" });
const r1 = await waitEv("message", (m) => m.groupId === "g-dev" && m.senderId === "ai-qa" && m.ts > t1 && m.text, 240000);
console.log(`    小满: ${r1.text.slice(0, 50).replace(/\n/g, " ")}`);
ok("第一轮对话完成（会话已建立）");

// 2) resetSession
const before = qaSessionArtefacts();
const rsAck = await new Promise((r) => sock.emit("resetSession", { agentId: "ai-qa" }, r));
if (!rsAck?.ok) fail("resetSession ack 失败", JSON.stringify(rsAck));
ok(`resetSession ack ok（隔离 ${rsAck.quarantined} 份旧日志）`);
const sysMsg = await waitEv("message", (m) => m.groupId === "g-dev" && m.senderId === "system" && m.text.includes("重置"), 10000);
ok("群内系统消息广播 ✓");

// 3) .stale 隔离目录出现
const after = qaSessionArtefacts();
if (after.stale <= before.stale) fail(`.stale 隔离数未增加 (before=${before.stale} after=${after.stale})`);
ok(`磁盘 .stale 隔离产物 ${before.stale} → ${after.stale} ✓`);

// 4) 重置后仍可正常对话（全新会话，不得报 id collision）
const t2 = Date.now();
sock.emit("send", { groupId: "g-dev", text: "@小满 现在还记得暗号吗？只回复记得或不记得" });
const r2 = await waitEv("message", (m) => m.groupId === "g-dev" && m.senderId === "ai-qa" && m.ts > t2 && m.text, 240000);
console.log(`    小满: ${r2.text.slice(0, 80).replace(/\n/g, " ")}`);
if (/collision|执行失败/.test(r2.text)) fail("重置后新会话异常（id collision）");
ok("重置后新会话正常（无 id collision）");

console.log(`\nSESSION-RESET-OK（${step} 步全部通过）`);
console.log(`（暗号验证请人工核对：应回答"不记得"→ ${r2.text.slice(0, 60).replace(/\n/g, " ")}）`);
sock.disconnect();
process.exit(0);
