/**
 * 联网能力实现层：web_fetch（抓网页 → 纯文本）与 web_search（多后端搜索）。
 * 纯 Node 依赖（内置 fetch + 正则），零外部依赖、零 key 亦可用（DuckDuckGo 后端）；
 * 与 sandbox.ts 同层定位：可单测、可替换，不 import langchain。
 * 设计要点：
 *   - 抓回来的内容先按体积/字符双重限额再进上下文（原始 HTML 直接灌进去会瞬间挤空窗口）
 *   - 私网地址默认放行（内网文档站/知识库是真实用法），可在设置里收紧为「仅公网」
 *   - 所有失败都转成可读中文文本返回（不抛异常），让模型自行换策略重试
 * --- @ty.aicoding@1789436639812 ---
 */
import { lookup } from "node:dns/promises";
import { decodeOutput } from "./sandbox.ts";
import type { WebConfig, WebSearchConfig } from "./types.ts";

/** 联网默认参数（页面设置为空时生效） */
export const WEB_DEFAULTS = {
  fetchTimeoutMs: 20_000,
  fetchMaxBytes: 2_000_000,
  fetchMaxChars: 8_000,
  searchCount: 8,
} as const;

/** 默认搜索后端：Bing 免 Key 且国内可直连（DuckDuckGo 在部分网络不可达，作为可选项保留） */
export const DEFAULT_SEARCH_PROVIDER = "bing";

/** 伪装常规浏览器 UA：不少站点对未知 UA 直接 403 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 agent-hive/0.1";

/**
 * 数值参数钳制：非法/空值回落默认，超界钳到边界。
 * --- @ty.aicoding@1789436639812 ---
 */
function clamp(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 补全协议并校验地址：仅允许 http/https（挡掉 file:/ftp: 等本地协议）。
 * --- @ty.aicoding@1789436639812 ---
 */
export function normalizeUrl(raw: string): URL {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("网址为空");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`网址格式不正确：${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`仅支持 http/https 网址（收到 ${u.protocol.replace(":", "")}）`);
  }
  if (!u.hostname) throw new Error(`网址缺少主机名：${raw}`);
  return u;
}

/**
 * 判定主机是否为「内网/本机/保留」地址（字面量判定，域名需 DNS 解析后二次判定）。
 * --- @ty.aicoding@1789436639812 ---
 */
export function isPrivateHost(host: string): boolean {
  let h = String(host ?? "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true; // 本机 / 10.x / 127.x
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16-31.x
    if (a === 192 && b === 168) return true; // 192.168.x
    if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
    if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
    if (a >= 224) return true; // 组播 / 保留
    return false;
  }
  if (h.includes(":")) {
    const x = h.startsWith("::ffff:") ? h.slice(7) : h; // IPv4 映射地址
    if (x.includes(".")) return isPrivateHost(x);
    if (x === "::1" || x === "::") return true;
    const head = x.split(":")[0];
    if (/^f[cd]/.test(head)) return true; // fc00::/7 唯一本地
    if (/^fe[89ab]/.test(head)) return true; // fe80::/10 链路本地
    return false;
  }
  return false;
}

/**
 * 严格模式下的主机准入：字面量 + DNS 解析结果双重判定（防「域名指向内网」绕过）。
 * allowPrivate=true 时直接放行。
 * --- @ty.aicoding@1789436639812 ---
 */
export async function assertHostAllowed(hostname: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  if (isPrivateHost(hostname)) throw new Error(`已禁止访问内网/本机地址：${hostname}`);
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":")) return; // 字面量 IP 已判定
  try {
    const addrs = await lookup(bare, { all: true });
    for (const a of addrs) {
      if (isPrivateHost(a.address)) throw new Error(`已禁止访问内网/本机地址：${hostname} → ${a.address}`);
    }
  } catch (e) {
    // 命中私网 → 原样抛出；其余（DNS 解析失败等）交给 fetch 报错，保留原始错误信息
    if (e instanceof Error && e.message.startsWith("已禁止访问")) throw e;
  }
}

/** 常见 HTML 实体表（覆盖中文页面高频实体） */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", middot: "·", times: "×", divide: "÷",
  copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", bull: "•",
  deg: "°", yen: "¥", euro: "€", pound: "£", sect: "§", para: "¶", permil: "‰",
};

/**
 * 解码 HTML 实体（命名实体 + 十进制/十六进制数字实体）。
 * --- @ty.aicoding@1789436639812 ---
 */
export function decodeEntities(s: string): string {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const cp = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return m;
        }
      }
      return m;
    }
    const k = g.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
  });
}

/**
 * HTML → 纯文本：剥脚本/样式/注释，块级标签转换行，解实体，压缩空白。
 * 返回标题与正文（标题用于给模型标明来源页面）。
 * --- @ty.aicoding@1789436639812 ---
 */
export function htmlToText(html: string): { title: string; text: string } {
  let s = String(html ?? "");
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  const title = t ? decodeEntities(t[1]).replace(/\s+/g, " ").trim() : "";
  s = s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol|dl|dd|dt|figure|figcaption)>/gi, "\n")
    .replace(/<(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol|dl|dd|dt|figure|figcaption)[^>]*>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  s = s
    .replace(/[ \t\f\v\u00a0\u3000]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return { title, text: s.trim() };
}

/**
 * 读响应体并按字节上限截断（流式累计，避免一次性拉入巨大响应）。
 * --- @ty.aicoding@1789436639812 ---
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const body = res.body;
  if (!body) {
    const all = Buffer.from(await res.arrayBuffer());
    return { buf: all.subarray(0, maxBytes), truncated: all.length > maxBytes };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    chunks.push(Buffer.from(value));
    total += value.length;
    if (total >= maxBytes) {
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* 取消失败不影响已读内容 */
      }
      break;
    }
  }
  return { buf: Buffer.concat(chunks).subarray(0, maxBytes), truncated };
}

/** 判断响应是否为「无法当文本读」的二进制类型 */
function isBinaryType(ctype: string): boolean {
  return (
    /^(image|audio|video|font)\//.test(ctype) ||
    /application\/(pdf|zip|gzip|octet-stream|x-tar|msword|vnd\.|x-7z|x-rar)/.test(ctype)
  );
}

/**
 * 抓取网址并转成纯文本（模型可直接读）。
 * 失败一律返回「❌ 抓取失败：…」文本而非抛异常，便于模型换地址重试。
 * --- @ty.aicoding@1789436639812 ---
 */
export async function webFetch(rawUrl: string, cfg?: WebConfig, maxCharsOverride?: number): Promise<string> {
  const allowPrivate = cfg?.allowPrivateHosts !== false;
  const timeoutMs = clamp(cfg?.fetchTimeoutMs, 2_000, 120_000, WEB_DEFAULTS.fetchTimeoutMs);
  const maxBytes = clamp(cfg?.fetchMaxBytes, 10_000, 20_000_000, WEB_DEFAULTS.fetchMaxBytes);
  const maxChars = clamp(maxCharsOverride ?? cfg?.fetchMaxChars, 500, 60_000, WEB_DEFAULTS.fetchMaxChars);

  let u: URL;
  try {
    u = normalizeUrl(rawUrl);
    await assertHostAllowed(u.hostname, allowPrivate);
  } catch (e) {
    return `❌ 抓取失败：${(e as Error).message}`;
  }

  try {
    const res = await fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) return `❌ 抓取失败：HTTP ${res.status} ${res.statusText}（${u.href}）`;
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (isBinaryType(ctype)) {
      return `❌ 该地址返回的是二进制内容（${ctype.split(";")[0] || "未知类型"}），无法作为文本读取：${u.href}`;
    }
    const { buf, truncated: bytesTruncated } = await readBodyCapped(res, maxBytes);
    const raw = decodeOutput(buf); // UTF-8 优先、非法则按 GBK —— 中文老站不乱码

    let title = "";
    let body: string;
    if (/json/.test(ctype)) {
      try {
        body = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        body = raw;
      }
    } else if (/html|xml/.test(ctype) || /^\s*(<!doctype|<html)/i.test(raw)) {
      const parsed = htmlToText(raw);
      title = parsed.title;
      body = parsed.text;
    } else {
      body = raw;
    }
    body = body.trim();

    const head = [res.redirected ? `来源：${u.href} → ${res.url}` : `来源：${u.href}`];
    if (title) head.push(`标题：${title}`);
    if (!body) {
      return `${head.join("\n")}\n\n（该地址没有可读正文，可能是纯前端渲染页面或空响应）`;
    }
    const cut = body.length > maxChars;
    const notes: string[] = [];
    if (cut) notes.push(`正文过长，仅展示前 ${maxChars} 字符（原文约 ${body.length} 字符）`);
    if (bytesTruncated) notes.push(`响应体超过 ${Math.round(maxBytes / 1024)}KB，已按上限截断`);
    const tail = notes.length ? `\n\n[${notes.join("；")}]` : "";
    return `${head.join("\n")}\n\n${cut ? body.slice(0, maxChars) : body}${tail}`;
  } catch (e) {
    const err = e as Error;
    const msg =
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? `请求超时（${timeoutMs}ms）`
        : err?.message || String(e);
    return `❌ 抓取失败：${msg}（${u.href}）`;
  }
}

/** 一条搜索结果 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** 去标签（搜索结果片段里常带 <b> 高亮） */
function stripTags(s: string): string {
  return String(s ?? "").replace(/<[^>]*>/g, "");
}

/**
 * 解析 DuckDuckGo 跳转链接（//duckduckgo.com/l/?uddg=<urlencoded> → 真实地址）。
 * --- @ty.aicoding@1789436639812 ---
 */
export function decodeDdgRedirect(href: string): string {
  const h = String(href ?? "").trim();
  if (!h) return "";
  const abs = h.startsWith("//") ? `https:${h}` : h;
  try {
    const u = new URL(abs, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    return target ? target.trim() : u.href;
  } catch {
    return "";
  }
}

/**
 * 解析 DuckDuckGo HTML 版结果页（免 key 后端）。
 * 以 result__a 锚点为分隔逐块取标题/链接/摘要——比「按索引配对两个正则」稳。
 * --- @ty.aicoding@1789436639812 ---
 */
export function parseDuckDuckGo(html: string, limit: number): SearchHit[] {
  const src = String(html ?? "");
  const marks: Array<{ idx: number; attrs: string }> = [];
  const aRe = /<a\b([^>]*class="[^"]*result__a[^"]*"[^>]*)>/gi;
  for (const m of src.matchAll(aRe)) marks.push({ idx: m.index ?? 0, attrs: m[1] });
  const hits: SearchHit[] = [];
  for (let i = 0; i < marks.length && hits.length < limit; i++) {
    const start = marks[i].idx;
    const end = i + 1 < marks.length ? marks[i + 1].idx : Math.min(src.length, start + 4_000);
    const seg = src.slice(start, end);
    const close = seg.indexOf("</a>");
    // 先去标签再解实体：反序会把 `&lt;b&gt;` 之类的转义文本误当标签剥掉
    const title = decodeEntities(stripTags(close >= 0 ? seg.slice(0, close) : seg)).replace(/\s+/g, " ").trim();
    const href = /href="([^"]*)"/i.exec(marks[i].attrs)?.[1] || /href="([^"]*)"/i.exec(seg)?.[1] || "";
    const url = decodeDdgRedirect(decodeEntities(href));
    const snipM = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)(?:<\/a>|<\/div>|<\/span>)/i.exec(seg);
    const snippet = snipM ? decodeEntities(stripTags(snipM[1])).replace(/\s+/g, " ").trim() : "";
    if (!url || !title) continue;
    hits.push({ title, url, snippet });
  }
  return hits;
}

/**
 * 解析 Bing 结果页（免 key 后端，国内可直连）。
 * 结果块为 `<li class="b_algo">`，标题取块内 h2 下的首个链接，摘要在 b_lineclamp 段落或 b_caption 里。
 * --- @ty.aicoding@1789436639812 ---
 */
export function parseBing(html: string, limit: number): SearchHit[] {
  const src = String(html ?? "");
  const blocks = src.split(/<li class="b_algo"/i).slice(1); // 每块 = 一条自然结果（首段是页头噪声）
  const hits: SearchHit[] = [];
  for (const b of blocks) {
    if (hits.length >= limit) break;
    const seg = b.slice(0, 20_000);
    const h2 = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(seg);
    if (!h2) continue;
    const url = decodeEntities(h2[1]).trim();
    const title = decodeEntities(stripTags(h2[2])).replace(/\s+/g, " ").trim();
    if (!/^https?:\/\//i.test(url) || !title) continue;
    const snip =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(seg) ||
      /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(seg);
    hits.push({
      title,
      url,
      snippet: snip ? decodeEntities(stripTags(snip[1])).replace(/\s+/g, " ").trim() : "",
    });
  }
  return hits;
}

/** SearXNG / Tavily 同构结果（title/url/content）统一转换 */
function fromGeneric(results: unknown, limit: number): SearchHit[] {
  if (!Array.isArray(results)) return [];
  return results
    .slice(0, limit)
    .map((r) => {
      const o = (r ?? {}) as { title?: unknown; url?: unknown; content?: unknown; snippet?: unknown };
      return {
        title: String(o.title ?? "").trim(),
        url: String(o.url ?? "").trim(),
        snippet: String(o.content ?? o.snippet ?? "").replace(/\s+/g, " ").trim(),
      };
    })
    .filter((h) => h.url);
}

/**
 * 解析 SearXNG JSON 接口结果。
 * --- @ty.aicoding@1789436639812 ---
 */
export function parseSearxng(json: unknown, limit: number): SearchHit[] {
  return fromGeneric((json as { results?: unknown })?.results, limit);
}

/**
 * 解析 Tavily 搜索结果。
 * --- @ty.aicoding@1789436639812 ---
 */
export function parseTavily(json: unknown, limit: number): SearchHit[] {
  return fromGeneric((json as { results?: unknown })?.results, limit);
}

/**
 * 解析博查（BochaAI）web-search 结果（data.webPages.value[{name,url,snippet,summary}]）。
 * --- @ty.aicoding@1789436639812 ---
 */
export function parseBocha(json: unknown, limit: number): SearchHit[] {
  const pages = (json as { data?: { webPages?: { value?: unknown } } })?.data?.webPages?.value;
  if (!Array.isArray(pages)) return [];
  return pages
    .slice(0, limit)
    .map((r) => {
      const o = (r ?? {}) as { name?: unknown; url?: unknown; snippet?: unknown; summary?: unknown };
      return {
        title: String(o.name ?? "").trim(),
        url: String(o.url ?? "").trim(),
        snippet: String(o.summary || o.snippet || "").replace(/\s+/g, " ").trim(),
      };
    })
    .filter((h) => h.url);
}

/** 搜索用 GET/POST 请求头 */
function searchHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "user-agent": UA, accept: "*/*", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", ...(extra || {}) };
}

/** Bing（免 key，可换镜像/自定义端点的 baseUrl）：GET 结果页 → 解析 */
async function searchBing(q: string, limit: number, timeoutMs: number, baseUrl?: string): Promise<SearchHit[]> {
  const base = (baseUrl || "").trim().replace(/\/+$/, "") || "https://cn.bing.com";
  const url = `${base}/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=${limit}`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: searchHeaders() });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}（${base}）`);
  const html = decodeOutput(Buffer.from(await res.arrayBuffer()));
  const hits = parseBing(html, limit);
  if (!hits.length && /captcha|验证码|人机|异常流量/i.test(html)) {
    throw new Error("搜索服务要求人机校验（可能被限流），可稍后重试或换搜索后端");
  }
  return hits;
}

/** DuckDuckGo（免 key）：POST 表单 → HTML 结果页 → 解析 */
async function searchDuckDuckGo(q: string, limit: number, timeoutMs: number): Promise<SearchHit[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: searchHeaders({ "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ q, kl: "wt-wt" }).toString(),
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = decodeOutput(Buffer.from(await res.arrayBuffer()));
  const hits = parseDuckDuckGo(html, limit);
  if (!hits.length && /anomaly|challenge|unusual traffic|captcha/i.test(html)) {
    throw new Error("搜索服务返回人机校验页（可能被限流或需要代理），可换搜索后端或稍后重试");
  }
  return hits;
}

/** SearXNG（自建/内网实例，需填实例地址）：JSON 接口 */
async function searchSearxng(q: string, limit: number, timeoutMs: number, baseUrl?: string): Promise<SearchHit[]> {
  const base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("未配置 SearXNG 实例地址（设置 → 联网 → 搜索地址）");
  const url = `${base}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: searchHeaders({ accept: "application/json" }) });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}（${base}）`);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error("搜索服务未返回 JSON（实例可能禁用了 format=json）");
  return parseSearxng(json, limit);
}

/** 博查 BochaAI（国内商用，需 key） */
async function searchBocha(q: string, limit: number, timeoutMs: number, baseUrl: string | undefined, apiKey: string): Promise<SearchHit[]> {
  const endpoint = (baseUrl || "").trim() || "https://api.bochaai.com/v1/web-search";
  const res = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: searchHeaders({ "content-type": "application/json", authorization: `Bearer ${apiKey}` }),
    body: JSON.stringify({ query: q, count: limit, summary: true, freshness: "noLimit" }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}${json ? "" : "（响应非 JSON）"}`);
  return parseBocha(json, limit);
}

/** Tavily（需 key） */
async function searchTavily(q: string, limit: number, timeoutMs: number, apiKey: string): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: searchHeaders({ "content-type": "application/json", authorization: `Bearer ${apiKey}` }),
    body: JSON.stringify({ query: q, max_results: limit, search_depth: "basic" }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}${json ? "" : "（响应非 JSON）"}`);
  return parseTavily(json, limit);
}

/**
 * 联网搜索：按配置后端分发，返回「编号 + 标题 + 链接 + 摘要」清单（模型可再 web_fetch 展开）。
 * 失败一律返回「❌ 搜索失败：…」文本而非抛异常。
 * --- @ty.aicoding@1789436639812 ---
 */
export async function webSearch(query: string, cfg?: WebConfig): Promise<string> {
  const q = String(query ?? "").trim();
  if (!q) return "❌ 搜索失败：查询词为空";
  const sc: WebSearchConfig = cfg?.search ?? {};
  const provider = sc.provider || DEFAULT_SEARCH_PROVIDER;
  const limit = clamp(sc.count, 1, 20, WEB_DEFAULTS.searchCount);
  const timeoutMs = clamp(cfg?.fetchTimeoutMs, 2_000, 120_000, WEB_DEFAULTS.fetchTimeoutMs);
  if (provider === "off") {
    return "❌ 联网搜索已关闭（可在 设置 → 联网 里选择搜索服务）。当前仅 web_fetch 可用：若有已知网址可直接抓取。";
  }
  const apiKey = (sc.apiKey || "").trim() || (provider === "bocha" ? process.env.BOCHA_API_KEY : process.env.TAVILY_API_KEY) || "";
  if ((provider === "bocha" || provider === "tavily") && !apiKey) {
    return `❌ 搜索失败：${provider} 需要 API Key（设置 → 联网 里填写，或设环境变量 ${provider === "bocha" ? "BOCHA_API_KEY" : "TAVILY_API_KEY"}）`;
  }
  try {
    let hits: SearchHit[];
    if (provider === "searxng") hits = await searchSearxng(q, limit, timeoutMs, sc.baseUrl);
    else if (provider === "bocha") hits = await searchBocha(q, limit, timeoutMs, sc.baseUrl, apiKey);
    else if (provider === "tavily") hits = await searchTavily(q, limit, timeoutMs, apiKey);
    else if (provider === "duckduckgo") hits = await searchDuckDuckGo(q, limit, timeoutMs);
    else hits = await searchBing(q, limit, timeoutMs, sc.baseUrl);
    if (!hits.length) {
      return `未搜到「${q}」的结果（服务：${provider}）。可换关键词重试，或用 web_fetch 打开已知网址。`;
    }
    const lines = hits.map((h, i) => `${i + 1}. ${h.title || "(无标题)"}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`);
    return `搜索「${q}」（${provider}）命中 ${hits.length} 条：\n\n${lines.join("\n")}\n\n（需要正文就用 web_fetch 打开其中某条链接）`;
  } catch (e) {
    const err = e as Error;
    const msg = err?.name === "TimeoutError" || err?.name === "AbortError" ? `请求超时（${timeoutMs}ms）` : err?.message || String(e);
    // 给出可操作出口：本网络下常是某后端不通，换后端即可（页面「设置 → 联网」）
    return `❌ 搜索失败：${msg}。可在 设置 → 联网 换搜索服务（bing / duckduckgo / searxng / bocha / tavily），或用 web_fetch 直接打开已知网址。`;
  }
}
