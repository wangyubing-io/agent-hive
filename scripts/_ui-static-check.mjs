// UI 静态校验：① index.html 内联脚本语法（node --check）② @ 补全 token 正则逻辑单测
// ③ 关键 DOM id 存在性 ④ theme.css 关键类存在性 ⑤ 关键功能逻辑 token 存在
// --- @ty.aicoding@1789436639812 ---
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let step = 0;
const ok = (name) => console.log(`  ✓ [${++step}] ${name}`);
const fail = (name, extra) => { console.error(`  ✗ [${step + 1}] ${name} ${extra || ""}`); process.exit(1); };

const html = readFileSync(join(process.cwd(), "apps", "web", "index.html"), "utf8");
const css = readFileSync(join(process.cwd(), "apps", "web", "theme.css"), "utf8");

// 1) 提取内联 <script>（最后一个大 IIFE）做语法检查
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) fail("未找到内联脚本");
const tmp = mkdtempSync(join(tmpdir(), "ui-check-"));
const jsFile = join(tmp, "inline.js");
let synErr = null;
for (const s of scripts) { // 逐块语法检查（主 IIFE + v5 微交互等多个 script 块）
  writeFileSync(jsFile, s);
  try {
    execFileSync(process.execPath, ["--check", jsFile], { stdio: "pipe" });
  } catch (e) {
    synErr = e;
    break;
  }
}
if (synErr) fail("内联脚本语法错误", String(synErr.stderr || synErr.message).slice(0, 300));
ok(`内联脚本语法检查通过（${scripts.length} 个 script 块）`);

// 2) @ token 正则逻辑（与 index.html currentAtToken 相同）
const re = () => /@([^\s@]{0,12})$/;
const cases = [
  ["帮我 @小", 5, { token: "小", start: 3 }],
  ["@小岚 帮我写页面 @", 11, { token: "", start: 10 }],
  ["@小岚 帮我", 8, null],
  ["邮箱 a@b", 6, { token: "b", start: 4 }],
  ["请 @老何 看看 @小满 的产", 15, null],
  ["请 @老何", 5, { token: "老何", start: 2 }],
];
for (const [text, pos, want] of cases) {
  const before = text.slice(0, pos);
  const m = before.match(re());
  const got = m ? { token: m[1], start: pos - m[0].length } : null;
  const norm = (x) => (x ? `${x.token}|${x.start}` : "null");
  if (norm(got) !== norm(want)) fail(`@token 用例「${text}」@${pos}`, `期望 ${norm(want)} 实际 ${norm(got)}`);
}
ok(`@ token 正则逻辑 ${cases.length} 用例全过`);

// 3) 关键 DOM id 存在（聊天/文件区/设置/搜索/导航/通讯录/新建群/加人 modal）
const ids = [
  "msgs", "input", "sendBtn", "memPanel", "grpName", "fileFilters", "filePreview",
  "setPanel", "agentEditors", "newAgentCard", "delGroupBtn", "exportBtn", "pvClose",
  "searchBox", "searchInput", "searchCount", "searchBtn",
  "addBtn", "navChat", "navContacts", "navSettings", "sidebarTitle",
  "attachBtn", "attachPreview", "fileInput",
  "newGroupModal", "ngName", "ngPick", "addMemberModal", "addPick",
  "contactList", "newContactBtn",
  "gitBar", "gbDir", "gbRepo", "gbCred", "gbWorkspace", "gbGitUrl", "gbClone", "gbBind", "gbAiHint",
  "webEnabled", "webAllowPrivate", "webSearchProvider", "webSearchBaseUrl", "webBaseUrlRow", "webKeyRow",
  "webSearchKey", "webSearchKeyClear", "webSearchCount", "webTimeout", "webMaxChars", "webHasKey", "saveWeb", "webMsg",
  // 备用模型（降级）+ 安全审批（危险命令闸门）
  // --- @ty.aicoding@1789443562072 ---
  "fbModel", "fbProtocol", "fbBaseUrl", "fbApiKey", "fbApiKeyClear", "fbHasKey",
  "apEnabled", "apTimeout", "apPatterns", "saveSafety", "safetyMsg",
];
for (const id of ids) {
  if (!html.includes(`id="${id}"`)) fail(`缺少 DOM id: ${id}`);
}
ok(`关键 DOM id ${ids.length} 个齐全`);
if (!scripts.some((s) => s.includes("atComplete"))) fail("脚本未创建 atComplete 浮层");
ok("atComplete 浮层在脚本中创建 ✓");

// 4) theme.css 关键类存在
for (const cls of [".orch .o-task", "#atComplete .ac-it", ".fp-preview", ".fp-filters .chip", ".msg.me .ops", ".search-box.open", ".search-count", ".modal-mask", ".modal", ".pick-item", ".contact", ".trace", ".trace-head", ".trace-body", ".msg-img", ".msg-file", ".msg-media", ".attach-preview", ".nav-btn", ".attach-btn", ".send-btn", ".bubble.media", ".load-more", ".gitbar", ".gb-main", ".gb-dirbtn", ".gb-ext", ".r-stream", ".msg.approval", ".ap-cmd", ".ap-act", ".o-meta", ".orch .o-meta"]) {
  if (!css.includes(cls)) fail(`theme.css 缺少 CSS: ${cls}`);
}
ok("theme.css 关键类齐全（导航/通讯录/modal/附件/思考过程/图片文件消息/流式正文/审批卡）");

// 5) 关键功能逻辑 token 存在
const inline = scripts.join("\n"); // 功能 token 跨所有 script 块（主 IIFE + v5 微交互）
for (const must of ["重发", "填回", "queued", "atComplete", "applySearch", "resetSearch", "uploadFile", "switchView", "renderContacts", "pickItem", "traceEl", "fileIcon", "pendingAttachments", "loadEarlier", "renderLoadMore", "historyMeta", "oldestTs", "loadAllForSearch", "renderGitBar", "fetchGitInfo", "saveGitCreds", "gitRepoInfo", "syncWebRows", "webSearchProvider",
  // 流式打字机 + 人工审批卡 + 编排结构化回报明细
  // --- @ty.aicoding@1789443562072 ---
  "streamDelta", "clearStream", "renderApproval", "resolveApprovalCard", "resolveApproval", "approvalResolved", "syncSafetyRows", "orchReportLine", "approval/wait"]) {
  if (!inline.includes(must)) fail(`内联脚本缺功能: ${must}`);
}
ok("重发/填回/排队/搜索/通讯录/上传/思考过程/历史分页/流式正文/审批卡逻辑在脚本中 ✓");

console.log(`\nUI-STATIC-OK（${step} 步全部通过）`);
