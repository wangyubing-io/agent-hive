/**
 * 迷你 Markdown 渲染器（零依赖，聊天气泡用）。
 * 安全设计：所有原文先做 HTML 转义，再应用白名单标签变换 —— 原文中的
 * <script>/<img>/on* 等永远不会以真实 HTML 形式进入 DOM；链接只放行 http(s)。
 * 支持：标题、围栏代码块、行内代码、加粗/斜体/删除线、链接、有序/无序列表、
 *       表格、引用块、分隔线、段落。
 */
function mdToHtml(src) {
  var esc = function (s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  // 行内元素（输入已转义）
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        function (m, t, u) {
          return /^https?:\/\//i.test(u)
            ? '<a class="md-link" href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + "</a>"
            : t; // 非 http(s) 链接（javascript: 等）降级为纯文本
        }
      )
      .replace(/\n/g, "<br>");
  }

  var lines = esc(String(src || "")).split("\n");
  var out = [];
  var i = 0;
  var isTableSep = function (l) {
    return /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.indexOf("-") >= 0;
  };

  while (i < lines.length) {
    var line = lines[i];

    // 围栏代码块
    if (/^```/.test(line)) {
      var code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾 ```
      out.push('<pre class="md-pre"><code>' + code.join("\n") + "</code></pre>");
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      var parseRow = function (l) {
        return l
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map(function (c) {
            return c.trim();
          });
      };
      var head = parseRow(line);
      i += 2;
      var rows = [];
      while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim()) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      out.push(
        '<table class="md-table"><thead><tr>' +
          head.map(function (h) {
            return "<th>" + inline(h) + "</th>";
          }).join("") +
          "</tr></thead><tbody>" +
          rows
            .map(function (r) {
              return (
                "<tr>" +
                r
                  .map(function (c) {
                    return "<td>" + inline(c) + "</td>";
                  })
                  .join("") +
                "</tr>"
              );
            })
            .join("") +
          "</tbody></table>"
      );
      continue;
    }

    // 标题
    var h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      var lv = h[1].length;
      out.push('<div class="md-h md-h' + lv + '">' + inline(h[2]) + "</div>");
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<div class="md-hr"></div>');
      i++;
      continue;
    }

    // 引用块（转义后 > 为 &gt;）
    if (/^\s*&gt;\s?/.test(line)) {
      var q = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*&gt;\s?/, ""));
        i++;
      }
      out.push('<blockquote class="md-quote">' + inline(q.join("\n")) + "</blockquote>");
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      var items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push(
        '<ul class="md-list">' +
          items.map(function (t) {
            return "<li>" + inline(t) + "</li>";
          }).join("") +
          "</ul>"
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      var ol = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        ol.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      out.push(
        '<ol class="md-list">' +
          ol.map(function (t) {
            return "<li>" + inline(t) + "</li>";
          }).join("") +
          "</ol>"
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 段落：连续收集直到空行或块级元素起始
    var para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(```|#{1,4}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*&gt;)/.test(lines[i]) &&
      !(
        lines[i].indexOf("|") >= 0 &&
        i + 1 < lines.length &&
        isTableSep(lines[i + 1])
      )
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push('<div class="md-p">' + inline(para.join("\n")) + "</div>");
  }
  return out.join("");
}

// node 环境导出（供单测使用；浏览器下无副作用）
if (typeof module !== "undefined" && module.exports) {
  module.exports = { mdToHtml: mdToHtml };
}
