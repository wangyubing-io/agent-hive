// 群内消息搜索模块校验（无浏览器环境）：
// ① DOM id / CSS 静态存在性
// ② 从 index.html 内联脚本提取「群内消息搜索」代码块，注入 stub DOM 做行为级验证
//    （开关 / 关键词过滤 / 命中计数 / 复位 / 新消息实时显隐 / 系统节点不残留 / 历史重放再过滤）
import { readFileSync } from "node:fs";
import { join } from "node:path";

let step = 0;
const ok = (name) => console.log(`  ✓ [${++step}] ${name}`);
const fail = (name, extra) => { console.error(`  ✗ [${step + 1}] ${name} ${extra || ""}`); process.exit(1); };

const html = readFileSync(join(process.cwd(), "apps", "web", "index.html"), "utf8");
const css = readFileSync(join(process.cwd(), "apps", "web", "theme.css"), "utf8");

// ---- 1) 静态存在性 ----
for (const id of ["searchBox", "searchInput", "searchCount", "searchBtn"]) {
  if (!html.includes(`id="${id}"`)) fail(`缺少 DOM id: ${id}`);
}
ok("搜索 DOM id（searchBox/searchInput/searchCount/searchBtn）齐全");
for (const cls of [".search-box", ".search-box.open", ".search-count"]) {
  if (!css.includes(cls)) fail(`theme.css 缺少 CSS: ${cls}`);
}
ok("搜索框 CSS（.search-box / .open / .search-count）齐全");

// ---- 2) 提取搜索代码块（以块注释为稳定边界） ----
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const src = scripts.find((s) => s.includes("// ---- 工作区内消息搜索")) || scripts[scripts.length - 1];
const i0 = src.indexOf("// ---- 工作区内消息搜索");
const i1 = src.indexOf("// ---- 发送");
if (i0 < 0 || i1 < 0 || i1 <= i0) fail("找不到搜索块边界标记");
const block = src.slice(i0, i1);
if (!block.includes("function applySearch") || !block.includes("function resetSearch")) {
  fail("搜索块缺少 applySearch/resetSearch");
}
ok("搜索块提取成功（含 applySearch / resetSearch / Escape / 新消息重过滤逻辑）");

// ---- 3) stub DOM 行为验证 ----
const fakeEl = (id) => {
  const _set = new Set();
  return {
    id, value: "", textContent: "",
    style: {},
    classList: { contains: (c) => _set.has(c), add: (c) => _set.add(c), remove: (c) => _set.delete(c) },
    _h: {},
    addEventListener(t, f) { this._h[t] = f; },
    fire(t, arg) { this._h[t] && this._h[t](arg); },
    focus() { this._focused = true; }, blur() { this._focused = false; },
  };
};
const els = { searchBox: fakeEl("searchBox"), searchInput: fakeEl("searchInput"), searchCount: fakeEl("searchCount"), searchBtn: fakeEl("searchBtn") };
const $ = (id) => els[id];
const mk = (text, isMsg) => ({ textContent: text, style: {}, classList: { contains: (c) => c === "msg" && isMsg } });
const msgsEl = {
  children: [], lastElementChild: null,
  appendChild(el) { this.children.push(el); this.lastElementChild = el; },
  scrollTop: 0, scrollHeight: 0,
};
const seed = (list) => { msgsEl.children = list; msgsEl.lastElementChild = list[list.length - 1] || null; };
const vis = (el) => el.style.display !== "none";
const appendMsgOrig = (m) => { const el = mk(m.text, m.isMsg); msgsEl.appendChild(el); return el; };
const renderHistoryOrig = (list) => { msgsEl.children = []; msgsEl.lastElementChild = null; list.forEach((m) => appendMsgOrig(m)); };

const api = new Function(
  "$", "msgsEl", "appendMsg", "renderHistory", "loadAllForSearch",
  block + "\n;return { applySearch, resetSearch, appendMsg, renderHistory };"
)($, msgsEl, appendMsgOrig, renderHistoryOrig, () => {}); // loadAllForSearch 由 _search-all-check 单独验证，这里空实现

const A = (cond, name, extra) => { if (!cond) fail(name, extra); ok(name); };

// 3.1 开关行为：点击展开 → 再点收起并复位
A(!els.searchBox.classList.contains("open"), "初始搜索框关闭");
els.searchBtn.fire("click");
A(els.searchBox.classList.contains("open"), "点击 🔍 展开搜索框");
els.searchBtn.fire("click");
A(!els.searchBox.classList.contains("open"), "再次点击关闭搜索框");
A(els.searchCount.textContent === "" && els.searchInput.value === "", "关闭时清空关键词与计数");

// 3.2 过滤与命中计数（系统提示节点不计入命中，但搜索期间一并隐藏）
const sys = mk("已连接服务端", false);
const m1 = mk("小岚：SDK 通道已跑通", true);
const m2 = mk("老何：接口文档已就绪", true);
seed([sys, m1, m2]);
els.searchBtn.fire("click");
els.searchInput.value = "sdk"; els.searchInput.fire("input");
A(vis(m1) && !vis(m2) && !vis(sys), "关键词 sdk：只显示命中消息");
A(els.searchCount.textContent === "命中 1 条", "命中计数 = 1 条");
els.searchInput.value = "就绪"; els.searchInput.fire("input");
A(!vis(m1) && vis(m2) && !vis(sys), "关键词切换后重新过滤");
A(els.searchCount.textContent === "命中 1 条", "切词后计数同步");
els.searchInput.value = ""; els.searchInput.fire("input");
A(vis(sys) && vis(m1) && vis(m2), "清空关键词：全部恢复显示（含系统提示）");
A(els.searchCount.textContent === "", "清空后计数消失");

// 3.3 系统提示命中不计条数（但可见）
els.searchInput.value = "服务端"; els.searchInput.fire("input");
A(vis(sys) && !vis(m1), "系统提示含关键词时可见");
A(els.searchCount.textContent === "无结果", "系统提示不参与命中计数");

// 3.4 搜索中到达的新消息按条件显隐
api.resetSearch();
seed([mk("部署完成", true), mk("接口文档已就绪", true)]);
els.searchBtn.fire("click");
els.searchInput.value = "文档"; els.searchInput.fire("input");
api.appendMsg({ text: "运维巡检报告", isMsg: true });
const n1 = msgsEl.lastElementChild;
A(!vis(n1), "不匹配的新消息被隐藏");
api.appendMsg({ text: "文档评审通过", isMsg: true });
const n2 = msgsEl.lastElementChild;
A(vis(n2) && els.searchCount.textContent === "命中 2 条", "匹配的新消息可见且计数 +1");

// 3.5 系统/状态节点：过滤触发时一并隐藏，reset 后必恢复（不留残留；直接到达的状态行不阻塞可见）
msgsEl.appendChild(mk("⏰ 定时任务执行", false));
const sys2 = msgsEl.lastElementChild;
A(vis(sys2), "搜索中直接到达的状态行保持可见（状态/进度不参与消息过滤）");
api.appendMsg({ text: "配置文档 v2 已上传", isMsg: true }); // 触发一次重过滤
A(!vis(sys2), "下一次重过滤时非匹配状态行一并隐藏");
A(els.searchCount.textContent === "命中 3 条", "重过滤后计数正确（含新增命中）");
api.resetSearch();
A(vis(sys2) && vis(n1) && vis(n2), "reset 后所有节点恢复显示（系统节点不残留）");

// 3.6 renderHistory 重放后重新应用搜索
api.resetSearch();
seed([]);
els.searchBtn.fire("click");
els.searchInput.value = "评审"; els.searchInput.fire("input");
api.renderHistory([
  { text: "第一轮：全绿", isMsg: true },
  { text: "交叉评审通过", isMsg: true },
  { text: "待定事项", isMsg: true },
]);
const after = msgsEl.children;
A(vis(after[1]) && !vis(after[0]) && !vis(after[2]), "历史重放后按关键词重新过滤");
A(els.searchCount.textContent === "命中 1 条", "重放后计数正确");
api.resetSearch();
A(vis(after[0]) && vis(after[2]) && els.searchCount.textContent === "", "重放后复位完整");

console.log(`\nSEARCH-UI-OK（${step} 步全部通过）`);
