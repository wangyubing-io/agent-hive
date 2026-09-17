// 搜索全历史回归：分页后进群只载最近一页，搜索激活时 loadAllForSearch 应自动拉全剩余历史再过滤
// 无浏览器：从内联脚本提取「历史分页」块，new Function 注入 stub DOM/socket 做行为级验证
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(process.cwd(), "apps", "web", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const script = scripts.find((s) => s.includes("// ---- 历史分页")) || scripts.at(-1);

// 提取「历史分页」块（oldestTs/renderLoadMore/loadEarlier/loadAllForSearch）
const start = script.indexOf("// ---- 历史分页");
const end = script.indexOf("function addSys");
if (start < 0 || end < 0) { console.error("FAIL: 未找到历史分页块边界"); process.exit(1); }
const block = script.slice(start, end);

let step = 0;
const ok = (n) => console.log(`  ✓ [${++step}] ${n}`);
const fail = (n, extra) => { console.error(`  ✗ [${step + 1}] ${n} ${extra || ""}`); process.exit(1); };

// ---- 假数据：总 130 条历史（ts 1..130），客户端初始只载最近 50（ts 81..130）----
const ALL = Array.from({ length: 130 }, (_, i) => ({ id: "m" + (i + 1), ts: i + 1 }));
const loaded = ALL.slice(-50); // ts 81..130

// ---- stub 环境 ----
const state = { historyHasMore: true, searchLoadingAll: false, searchQ: "", curGroupId: "g-dev", loadingEarlier: false };
let msgs = loaded.map((m) => msgEl(m)); // 当前 DOM 中已渲染的消息节点（含 data-ts）
let applySearchCalls = 0;
const counters = { applySearch: 0 };
const emitCalls = []; // 记录 loadEarlier 的 beforeTs

function makeBtn() { return { className: "", textContent: "", addEventListener() {}, remove() {}, dataset: {} }; }
const btn = makeBtn(); // 当前 .load-more 节点

const fragFactory = () => {
  const nodes = [];
  return { nodes, appendChild(n) { nodes.push(n); } };
};

const msgsEl = {
  _children: () => [...msgs],
  querySelector(sel) {
    if (sel === ".load-more") return state.historyHasMore ? btn : null;
    if (sel === ".msg") return msgs.find((m) => m.dataset && m.dataset.ts) || null;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === ".msg") return msgs.filter((m) => m.dataset && m.dataset.ts);
    return [];
  },
  insertBefore(frag, ref) {
    const nodes = frag.nodes || [];
    const idx = msgs.indexOf(ref);
    if (idx < 0) msgs.push(...nodes);
    else msgs.splice(idx, 0, ...nodes);
  },
  appendChild(n) { msgs.push(n); },
  prepend(n) { /* renderLoadMore 的 prepend 用不到（stub 里 btn 已存在） */ },
  scrollHeight: 0,
  scrollTop: 0,
};

function msgEl(m) { return { dataset: { ts: m.ts }, textContent: m.text || "", remove() {} }; }

const socket = {
  emit(ev, payload, ack) {
    if (ev === "loadEarlier") {
      emitCalls.push(payload.beforeTs);
      const older = ALL.filter((m) => m.ts < payload.beforeTs);
      const limit = 50;
      const hasMore = older.length > limit;
      const messages = older.slice(Math.max(0, older.length - limit));
      ack({ ok: true, messages, hasMore });
    } else if (typeof ack === "function") ack({ ok: true });
  },
};

function applySearch() { applySearchCalls++; counters.applySearch++; }

const document = { createElement() { return makeBtn(); }, createDocumentFragment: fragFactory };

// 把块内函数 + 测试驱动代码放进同一作用域执行
const preamble = `let historyHasMore, searchLoadingAll, searchQ, curGroupId, loadingEarlier;`;
const driver = `
historyHasMore = ${JSON.stringify(state.historyHasMore)};
searchLoadingAll = false;
searchQ = "";
curGroupId = "g-dev";
loadingEarlier = false;

loadAllForSearch();

// 断言
if (!Array.isArray(msgs) || msgs.length !== 130) fail("加载后消息总数应为 130", "got " + (msgs && msgs.length));
if (historyHasMore !== false) fail("拉全后 historyHasMore 应为 false");
if (searchLoadingAll !== false) fail("结束后 searchLoadingAll 应复位 false");
if (counters.applySearch < 1) fail("结束时应调用 applySearch 过滤");
// beforeTs 应严格递减：81 → 31 → (31 之前无更多，不再调用)
if (emitCalls.length !== 2) fail("loadEarlier 应调用 2 次", "got " + emitCalls.length + " " + JSON.stringify(emitCalls));
if (emitCalls[0] !== 81 || emitCalls[1] !== 31) fail("loadEarlier beforeTs 序列应为 81→31", JSON.stringify(emitCalls));
ok("loadAllForSearch 自动拉全剩余 80 条（2 次翻页），hasMore 收敛为 false");
ok("结束后调用 applySearch 完成过滤");
`;

const fn = new Function("msgsEl", "msgEl", "socket", "applySearch", "document", "fail", "ok", "msgs", "emitCalls", "counters", preamble + block + driver);
fn(msgsEl, msgEl, socket, applySearch, document, fail, ok, msgs, emitCalls, counters);

console.log(`\nSEARCH-ALL-OK（${step} 步全部通过）`);
