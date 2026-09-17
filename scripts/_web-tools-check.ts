/**
 * 离线单测：联网能力（web_fetch / web_search）。
 * 全部用固定 fixture，不发起任何网络请求（私网拦截/缺 Key/关闭搜索都在请求前返回）。
 * 覆盖：URL 校验、私网判定、实体解码、HTML→纯文本、DDG 结果解析、各搜索后端解析、工具注册与白名单。
 * --- @ty.aicoding@1789436639812 ---
 */
import {
  normalizeUrl,
  isPrivateHost,
  decodeEntities,
  htmlToText,
  parseDuckDuckGo,
  parseBing,
  parseSearxng,
  parseBocha,
  parseTavily,
  webFetch,
  webSearch,
} from "../packages/core/src/web.ts";
import { buildSandboxTools } from "../packages/core/src/llm.ts";
import type { WebConfig } from "../packages/core/src/types.ts";

let step = 0;
const ok = (name: string) => console.log(`  ✓ [${++step}] ${name}`);
const fail = (name: string, extra?: unknown) => {
  console.error(`  ✗ [${step + 1}] ${name} ${extra === undefined ? "" : String(extra)}`);
  process.exit(1);
};
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(name, `\n     期望 ${JSON.stringify(want)}\n     实际 ${JSON.stringify(got)}`);
  }
  ok(name);
};

// ---------- 1) URL 校验 ----------
eq("无协议自动补 https", normalizeUrl("nodejs.org/api/sqlite.html").href, "https://nodejs.org/api/sqlite.html");
eq("显式 http 保留协议", normalizeUrl("http://a.example.com/x").protocol, "http:");
for (const bad of ["", "file:///etc/passwd", "ftp://files.example.com/a"]) {
  let threw = false;
  try {
    normalizeUrl(bad);
  } catch {
    threw = true;
  }
  if (!threw) fail(`应被拒绝的地址未拦截：${JSON.stringify(bad)}`);
}
ok("拒绝空地址 / file: / ftp:（3 例）");

// ---------- 2) 私网判定 ----------
const privateHosts = [
  "192.168.1.1", "127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1",
  "169.254.169.254", "100.64.0.1", "224.0.0.1", "localhost", "wiki.local", "[::1]", "fd00::1", "fe80::1",
];
for (const h of privateHosts) if (!isPrivateHost(h)) fail(`私网判定漏判：${h}`);
ok(`内网/本机地址判定 ${privateHosts.length} 例全中`);
const publicHosts = ["8.8.8.8", "172.32.0.1", "1.1.1.1", "example.com", "github.com"];
for (const h of publicHosts) if (isPrivateHost(h)) fail(`公网地址被误判为内网：${h}`);
ok(`公网地址判定 ${publicHosts.length} 例全过`);

// ---------- 3) 实体解码 / HTML → 纯文本 ----------
eq("HTML 实体解码（命名 + 十进制 + 十六进制）", decodeEntities("A&amp;B &lt;b&gt; &#39;q&#39; &#x4e2d;"), "A&B <b> 'q' 中");
const page = `<html><head><title>文档 &amp; 标题</title><style>body{color:red}</style><script>var a=1;</script></head>
<body><!-- 注释 --><nav>导航噪声</nav><h1>第一段</h1><p>段落&amp;内容</p><ul><li>项一</li><li>项二</li></ul><div>尾&nbsp;行</div></body></html>`;
const parsed = htmlToText(page);
eq("标题提取 + 实体解码", parsed.title, "文档 & 标题");
for (const noise of ["color:red", "var a=1", "注释", "导航噪声"]) {
  if (parsed.text.includes(noise)) fail(`未剥离内容：${noise}`, parsed.text.slice(0, 200));
}
ok("script / style / 注释 / nav 噪声已剥离");
for (const keep of ["第一段", "段落&内容", "项一", "项二", "尾 行"]) {
  if (!parsed.text.includes(keep)) fail(`正文丢失：${keep}`, parsed.text.slice(0, 200));
}
ok("正文（标题/段落/列表/实体）完整保留");

// ---------- 4) DuckDuckGo 结果解析（含跳转链接还原） ----------
const ddgHtml = `<div class="result">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fsqlite.html&amp;rut=1">Node.js SQLite &lt;docs&gt;</a></h2>
<a class="result__snippet" href="#">The node:sqlite <b>module</b> provides DatabaseSync.</a>
</div>
<div class="result">
<h2><a class="result__a" href="https://example.com/b">Second &amp; Result</a></h2>
<a class="result__snippet">Second snippet.</a>
</div>`;
const ddg = parseDuckDuckGo(ddgHtml, 8);
eq("DDG 命中条数", ddg.length, 2);
eq("DDG 跳转链接还原为真实地址", ddg[0].url, "https://nodejs.org/api/sqlite.html");
eq("DDG 标题转义还原（& 与 <docs>）", ddg[0].title, "Node.js SQLite <docs>");
eq("DDG 摘要去高亮标签", ddg[0].snippet, "The node:sqlite module provides DatabaseSync.");
eq("DDG 直连链接原样保留", ddg[1].url, "https://example.com/b");
eq("DDG limit 生效", parseDuckDuckGo(ddgHtml, 1).length, 1);

// ---------- 5) 其它搜索后端解析 ----------
const bingHtml = `<ol id="b_results"><li class="b_algo"><h2><a href="https://nodejs.org/">Node.js &#8212; 运行时</a></h2>
<div class="b_caption"><p class="b_lineclamp2">Node.js is a <strong>runtime</strong>.</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/x">第二条 &amp; 结果</a></h2><div class="b_caption"><p>摘要二。</p></div></li></ol>`;
const bing = parseBing(bingHtml, 8);
eq("Bing 命中条数", bing.length, 2);
eq(
  "Bing 标题/链接/摘要（实体解码 + 去高亮标签）",
  bing[0],
  { title: "Node.js — 运行时", url: "https://nodejs.org/", snippet: "Node.js is a runtime." }
);
eq("Bing caption 兜底取摘要 + 实体还原", bing[1], { title: "第二条 & 结果", url: "https://example.com/x", snippet: "摘要二。" });
eq("Bing limit 生效", parseBing(bingHtml, 1).length, 1);

eq("SearXNG 解析（title/url/content）", parseSearxng({ results: [{ title: "T1", url: "https://a.com", content: " c1 " }] }, 8), [
  { title: "T1", url: "https://a.com", snippet: "c1" },
]);
eq("博查解析（data.webPages.value）", parseBocha({ data: { webPages: { value: [{ name: "N1", url: "https://b.com", summary: " S1 " }] } } }, 8), [
  { title: "N1", url: "https://b.com", snippet: "S1" },
]);
eq("Tavily 解析", parseTavily({ results: [{ title: "T2", url: "https://c.com", content: "s2" }] }, 8), [
  { title: "T2", url: "https://c.com", snippet: "s2" },
]);
eq("异常结构（非数组）不炸", parseSearxng({ error: "bad" }, 8), []);
ok("坏数据兜底为空数组");

// ---------- 6) 工具注册与白名单 ----------
const webToolNames = (web?: WebConfig) =>
  buildSandboxTools("data/tests/web-tools", { web })
    .map((t) => t.name)
    .filter((n) => n.startsWith("web_"));
eq("默认配置 → 注册 web_fetch + web_search", webToolNames(undefined), ["web_fetch", "web_search"]);
eq("搜索后端 off → 只留 web_fetch", webToolNames({ enabled: true, search: { provider: "off" } }), ["web_fetch"]);
eq("总开关关闭 → 不注册任何联网工具", webToolNames({ enabled: false }), []);
eq(
  "白名单只放行 web_fetch",
  buildSandboxTools("data/tests/web-tools", { web: {}, allowed: ["web_fetch", "read_file"] })
    .map((t) => t.name)
    .filter((n) => n.startsWith("web_")),
  ["web_fetch"]
);

// ---------- 7) 请求前拦截（离线可验，不会有真实网络请求） ----------
const blocked = await webFetch("http://192.168.1.10/secret", { allowPrivateHosts: false });
if (!blocked.startsWith("❌") || !blocked.includes("已禁止访问")) fail("严格模式未拦下内网地址", blocked);
ok("「仅公网」模式拦下内网地址（未发起请求）");
const badScheme = await webFetch("file:///etc/passwd");
if (!badScheme.startsWith("❌")) fail("file: 协议未被拦截", badScheme);
ok("file: 协议被拦截（未发起请求）");
const searchOff = await webSearch("node sqlite", { search: { provider: "off" } });
if (!searchOff.includes("已关闭")) fail("provider=off 未给出说明", searchOff);
ok("搜索后端 off → 明确提示且不联网");
if (!process.env.BOCHA_API_KEY) {
  const noKey = await webSearch("x", { search: { provider: "bocha" } });
  if (!noKey.includes("需要 API Key")) fail("缺 Key 未给出提示", noKey);
  ok("bocha 缺 Key → 明确提示（未发起请求）");
}

console.log(`\nWEB-TOOLS-OK（${step} 步全部通过）`);
