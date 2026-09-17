// 历史分页 E2E：进群只推最近一页（≤50），loadEarlier 按 ts 翻上一页，且拼回全量无丢失/无重复
// 无浏览器，走真实 socket；ground truth 直接读 data/messages/<gid>.jsonl（同机文件系统）做精确比对
import { io } from "socket.io-client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const URL = "http://127.0.0.1:18741";
const GID = "g-dev"; // 开发群：历史 > 50 条（分页才有意义）
const socket = io(URL, { transports: ["websocket"] });

// ground truth：磁盘上该群全部消息（升序，append-only）
const raw = readFileSync(join(process.cwd(), "data", "messages", `${GID}.jsonl`), "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .sort((a, b) => a.ts - b.ts);
const ids = (arr) => arr.map((m) => m.id).join(",");

let step = 0;
const ok = (n) => console.log(`  ✓ [${++step}] ${n}`);
const fail = (n, extra) => { console.error(`  ✗ [${step + 1}] ${n} ${extra || ""}`); process.exit(1); };

let page = [];
let meta = null;
socket.on("history", (l) => { page = l || []; });
socket.on("historyMeta", (m) => { meta = m || null; });
const waitConn = () => new Promise((res) => { if (socket.connected) res(); else socket.once("connect", res); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadEarlier = (beforeTs) => new Promise((res, rej) => {
  socket.emit("loadEarlier", { groupId: GID, beforeTs }, (r) => (r && r.ok ? res(r) : rej(new Error(r?.error || "loadEarlier failed"))));
});

const main = async () => {
  if (raw.length <= 50) fail("测试前提不满足：g-dev 历史需 > 50 条", `got ${raw.length}`);
  await waitConn();
  socket.emit("joinGroup", { groupId: GID });
  for (let i = 0; i < 40 && (!meta || page.length === 0); i++) await sleep(100);
  if (page.length === 0) fail("未收到 history");
  if (!meta) fail("未收到 historyMeta");

  // ① 首屏 = 最近 50 条（ground truth 尾部），hasMore=true
  const expectPage = raw.slice(raw.length - 50);
  if (ids(page) !== ids(expectPage)) fail("首屏与 ground truth 最近 50 条不一致");
  if (meta.hasMore !== true) fail("hasMore 应为 true", JSON.stringify(meta));
  ok(`首屏 = 最近 50 条，hasMore=true`);

  // ② 翻上一页：应精确返回 beforeTs 之前的全部剩余消息（剩余 < 一页，hasMore=false，且不得截断丢失）
  const beforeTs = page[0].ts;
  const expectOlder = raw.filter((m) => m.ts < beforeTs);
  const r1 = await loadEarlier(beforeTs);
  if (ids(r1.messages) !== ids(expectOlder)) fail("第一页翻页结果丢失/错序", `expect ${expectOlder.length} got ${r1.messages.length}`);
  if (r1.hasMore !== false) fail("剩余不足一页时 hasMore 应为 false", JSON.stringify(r1.hasMore));
  ok(`第一页翻回 ${r1.messages.length} 条 = 全部剩余消息，无丢失，hasMore=false`);

  // ③ 双向拼合 = 全量，且严格升序（覆盖「连续翻页」路径）
  const all = [...r1.messages, ...page];
  if (ids(all) !== ids(raw)) fail("拼合结果 != ground truth 全量");
  const asc = all.every((m, i) => i === 0 || m.ts >= all[i - 1].ts);
  if (!asc) fail("拼合结果未严格升序");
  ok(`拼合还原全量 ${raw.length} 条，严格升序，与磁盘一致`);

  console.log(`\nHISTORY-PAGE-OK（${step} 步全部通过，全量 ${raw.length} 条）`);
  process.exit(0);
};

main().catch((e) => { console.error("\nHISTORY-PAGE-FAIL:", e.message || e); process.exit(1); });
setTimeout(() => { console.error("GLOBAL TIMEOUT"); process.exit(2); }, 30000);
