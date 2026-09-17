// E2E: 联网配置（设置面板 ↔ 服务端 ↔ settings.json）
// 验证点:
//  1) 连接收到 settings 且含 web 配置（默认 bing / 启用 / 允许内网）
//  2) updateSettings 写入联网字段 → ack + 广播 + 落盘 settings.json
//  3) 搜索 Key 只回传布尔（广播里不含明文），但本机 settings.json 有存
//  4) webSearchBaseUrl 非法协议 → ack 失败并给出中文提示
//  5) 复位为默认（不留脏配置）
// --- @ty.aicoding@1789436639812 ---
import { io } from "socket.io-client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.AH_URL || "http://127.0.0.1:18741";
const SETTINGS_FILE = join(process.cwd(), "data", "settings.json");
let step = 0;
const ok = (name) => console.log(`  ✓ [${++step}] ${name}`);
const fail = (name, extra) => { console.error(`  ✗ [${step + 1}] ${name} ${extra || ""}`); process.exit(1); };

const sock = io(URL, { transports: ["websocket"] });
const waitEv = (ev, pred, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error(`等 ${ev} 超时`)); }, timeout);
    const h = (payload) => { try { if (!pred || pred(payload)) { clearTimeout(t); sock.off(ev, h); resolve(payload); } } catch {} };
    sock.on(ev, h);
  });
const emit = (ev, payload) => new Promise((r) => sock.emit(ev, payload, r));
const disk = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));

await new Promise((r) => sock.on("connect", r));

// 1) 默认联网配置
const s0 = await waitEv("settings", (s) => s && !!s.web);
if (s0.web.enabled !== true) fail("默认应启用联网");
if (s0.web.allowPrivateHosts !== true) fail("默认应允许内网地址");
if (s0.web.searchProvider !== "bing") fail(`默认搜索源应为 bing，实际 ${s0.web.searchProvider}`);
if (s0.web.searchHasKey !== false) fail("未配 Key 时应为 false");
ok(`settings.web 默认值正确（provider=${s0.web.searchProvider} enabled=${s0.web.enabled}）`);

// 2) 写联网配置 → 广播 + 落盘
const a1 = await emit("updateSettings", {
  webSearchProvider: "bocha",
  webSearchCount: 5,
  webFetchTimeout: 11000,
  webFetchMaxChars: 4000,
  webAllowPrivate: false,
});
if (!a1?.ok) fail("updateSettings(联网) ack 失败", JSON.stringify(a1));
const s1 = await waitEv("settings", (s) => s.web && s.web.searchProvider === "bocha");
if (s1.web.searchCount !== 5 || s1.web.fetchTimeoutMs !== 11000 || s1.web.fetchMaxChars !== 4000) {
  fail("广播的联网限额与提交不一致", JSON.stringify(s1.web));
}
if (s1.web.allowPrivateHosts !== false) fail("allowPrivateHosts 应为 false");
ok("updateSettings → ack ok + 广播（provider/条数/超时/正文上限/内网开关）");
const d1 = disk().web;
if (d1.search.provider !== "bocha" || d1.search.count !== 5 || d1.fetchTimeoutMs !== 11000 || d1.fetchMaxChars !== 4000) {
  fail("settings.json 未正确落盘", JSON.stringify(d1));
}
if (d1.allowPrivateHosts !== false) fail("settings.json 未落盘 allowPrivateHosts");
ok("settings.json 落盘 web 配置 ✓");

// 3) Key 只回传布尔
const a2 = await emit("updateSettings", { webSearchKey: "sk-e2e-not-real" });
if (!a2?.ok) fail("写入搜索 Key 失败");
const s2 = await waitEv("settings", (s) => s.web && s.web.searchHasKey === true);
if (JSON.stringify(s2).includes("sk-e2e-not-real")) fail("广播里泄露了 Key 明文");
ok("搜索 Key 已保存（广播仅回传布尔，无明文泄露）");
if (disk().web.search.apiKey !== "sk-e2e-not-real") fail("Key 未落到本机 settings.json");
ok("Key 存于本机 settings.json（与 LLM Token 同策略）");

// 4) 非法搜索地址被拒
const a3 = await emit("updateSettings", { webSearchBaseUrl: "192.168.1.10:8080" });
if (a3?.ok !== false || !String(a3?.error || "").includes("http")) fail("非法搜索地址未被拒绝", JSON.stringify(a3));
ok("非法搜索地址 → ack 失败 + 中文提示");

// 5) 复位默认
const a4 = await emit("updateSettings", {
  webSearchProvider: "bing",
  webSearchCount: null,
  webFetchTimeout: null,
  webFetchMaxChars: null,
  webAllowPrivate: true,
  webSearchBaseUrl: "",
  webSearchKeyClear: true,
});
if (!a4?.ok) fail("复位失败");
const s3 = await waitEv("settings", (s) => s.web && s.web.searchProvider === "bing" && s.web.searchHasKey === false);
if (s3.web.searchCount !== null || s3.web.fetchTimeoutMs !== null || s3.web.fetchMaxChars !== null) {
  fail("限额未清空（应回落默认）", JSON.stringify(s3.web));
}
const d2 = disk().web;
if (d2.search.apiKey) fail("Key 未清除");
if (d2.fetchTimeoutMs || d2.fetchMaxChars || d2.search.count) fail("settings.json 仍有残留限额");
ok("已复位为默认（限额清空、Key 清除、provider=bing）");

console.log(`\nWEB-SETTINGS-OK（${step} 步全部通过）`);
sock.disconnect();
process.exit(0);
