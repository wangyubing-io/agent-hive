// md.js 单测：markdown 特性 + XSS 防护
import { readFileSync } from "node:fs";
const mdToHtml = new Function(
  readFileSync(new URL("../apps/web/md.js", import.meta.url), "utf8") + "\n;return mdToHtml;"
)();

let pass = 0, fail = 0;
const t = (name, src, checks) => {
  const html = mdToHtml(src);
  const ok = checks.every(([re, should]) => (should ? re.test(html) : !re.test(html)));
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log("    html:", html.slice(0, 300));
    for (const [re, should] of checks) {
      if (re.test(html) !== should) console.log(`    期望${should ? "" : "不"}匹配 ${re}，实际${re.test(html) ? "匹配" : "不匹配"}`);
    }
  }
};

// ---- 基础特性 ----
t("标题", "# 大标题\n## 二级", [[/md-h1.*大标题/, true], [/md-h2.*二级/, true]]);
t("加粗斜体删除线", "**粗** *斜* ~~删~~", [[/<strong>粗<\/strong>/, true], [/<em>斜<\/em>/, true], [/<del>删<\/del>/, true]]);
t("行内代码", "用 `npm run dev` 启动", [[/<code class="md-code">npm run dev<\/code>/, true]]);
t("代码块", "```\nconst a=1;\n```", [[/<pre class="md-pre"><code>const a=1;/, true]]);
t("无序列表", "- 甲\n- 乙", [[/<ul class="md-list">.*<li>甲<\/li>.*<li>乙<\/li>/s, true]]);
t("有序列表", "1. 一\n2. 二", [[/<ol class="md-list">.*<li>一<\/li>/s, true]]);
t("引用", "> 引用内容", [[/<blockquote class="md-quote">引用内容<\/blockquote>/, true]]);
t("分隔线", "---", [[/md-hr/, true]]);
t("链接", "[文档](https://example.com)", [[/href="https:\/\/example\.com"/, true], [/target="_blank"/, true]]);

// ---- 表格 ----
t("表格", "| 方法 | 路径 |\n|---|---|\n| GET | /api/items |", [
  [/md-table/, true], [/<th>方法<\/th>/, true], [/<td>\/api\/items<\/td>/, true],
]);
t("表格带对齐", "| A | B |\n|:--|--:|\n| 1 | 2 |", [[/<td>1<\/td>/, true]]);

// ---- XSS 防护 ----
t("script 标签转义", '正常<script>alert(1)<\/script>文本', [
  [/<script>/, false], [/&lt;script&gt;/, true],
]);
t("img onerror 转义", '![x](y)" onerror="alert(1)', [
  [/<img/, false], // 不产生真实 img 标签（onerror 以转义文本形式存在，安全）
  [/&quot; onerror=&quot;/, true],
]);
t("javascript: 链接降级", "[点我](javascript:alert(1))", [
  [/href="javascript:/, false], [/点我/, true],
]);
t("代码块内 script 转义", "```\n<script>bad()<\/script>\n```", [
  [/<script>bad/, false], [/&lt;script&gt;bad\(\)&lt;\/script&gt;/, true],
]);
t("表格单元格注入", "| a |\n|---|\n| <img src=x> |", [[/<img src=x>/, false], [/&lt;img src=x&gt;/, true]]);

console.log(`\n${fail === 0 ? "MD-TEST-OK" : "MD-TEST-FAIL"} (${pass} pass / ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
