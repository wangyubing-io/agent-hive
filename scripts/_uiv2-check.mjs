// UI v2 运行时 E2E：验证第 15 轮迭代的新能力（无浏览器，走真实 socket + HTTP）
// ① 文件上传 / 下载  ② 附件消息(file)/图片消息(image)  ③ createGroup 带成员  ④ 拉人进群
// ⑤ agent 回复带思考过程 trace（真实 LLM）
import { io } from "socket.io-client";

const URL = "http://127.0.0.1:18741";
const GID = "g-dev";
const socket = io(URL, { transports: ["websocket"] });

let step = 0;
const ok = (n) => console.log(`  ✓ [${++step}] ${n}`);
const fail = (n, extra) => { console.error(`  ✗ [${step + 1}] ${n} ${extra || ""}`); process.exit(1); };

// 事件收集
const inbox = [];
let history = [], agents = [];
socket.on("connect", () => console.log("[client] connected"));
socket.on("history", (l) => { history = l || []; });
socket.on("agents", (a) => { agents = a || []; });
socket.on("message", (m) => inbox.push(m));
socket.on("orchestration", () => {}); // 编排事件静默（避免 lead 编排干扰断言）

const waitMsg = (pred, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const seen = inbox.findIndex(pred);
  if (seen >= 0) return resolve(inbox[seen]);
  const iv = setInterval(() => {
    const i = inbox.findIndex(pred);
    if (i >= 0) { clearInterval(iv); resolve(inbox[i]); }
    else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("timeout waiting message")); }
  }, 200);
});
const waitConn = () => new Promise((res) => { if (socket.connected) res(); else socket.once("connect", res); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function upload(groupId, name, content, mime) {
  const data = Buffer.from(content, "utf8");
  const res = await fetch(URL + "/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ groupId, name, size: data.length, mime, data: data.toString("base64") }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "upload failed");
  return j.file;
}

const main = async () => {
  await waitConn();
  // 确保已 join 群（history 才推给本连接）；joinGroup 有 ack 吗？无，靠 history 事件
  socket.emit("joinGroup", { groupId: GID });
  await sleep(600);

  // ① 上传 + 下载
  const f1 = await upload(GID, "hello-upload.txt", "hello agent-hive v2 upload\n", "text/plain");
  ok(`上传文本文件: ${f1.name} → ${f1.url}`);
  const dl = await fetch(URL + f1.url);
  const dlText = await dl.text();
  if (dlText !== "hello agent-hive v2 upload\n") fail("下载内容不一致", dlText);
  ok("下载内容与上传一致");

  // ② 附件消息(file) —— text 以问候语开头，避免触发 lead 编排
  socket.emit("send", { groupId: GID, text: "你好，测试附件", attachments: [{ id: f1.id, name: f1.name, size: f1.size, mime: f1.mime, url: f1.url }] });
  const mf = await waitMsg((m) => m.groupId === GID && m.kind === "file" && m.attachments?.length === 1);
  ok(`附件消息 kind=${mf.kind}，附件=${mf.attachments[0].name}`);

  // ③ 图片消息(image) —— 1x1 透明 png
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const imgRes = await fetch(URL + "/api/upload", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ groupId: GID, name: "pixel.png", size: PNG.length, mime: "image/png", data: PNG.toString("base64") }),
  });
  const imgFile = (await imgRes.json()).file;
  socket.emit("send", { groupId: GID, text: "", attachments: [{ id: imgFile.id, name: imgFile.name, size: imgFile.size, mime: imgFile.mime, url: imgFile.url }] });
  const mi = await waitMsg((m) => m.groupId === GID && m.kind === "image" && m.attachments?.length === 1);
  ok(`图片消息 kind=${mi.kind}，附件=${mi.attachments[0].name}`);
  const imgResp = await fetch(URL + imgFile.url);
  const ct = imgResp.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) fail("图片 content-type 非 image/*", ct);
  ok(`图片下载 content-type=${ct}`);

  // ④ createGroup 带成员（只拉 ai-qa）
  const gname = "E2E测试群-" + Date.now().toString(36).slice(-5);
  const qa = agents.find((a) => a.id === "ai-qa");
  const fe = agents.find((a) => a.id === "ai-fe");
  const cg = await new Promise((res) => socket.emit("createGroup", { name: gname, memberIds: [qa.id] }, res));
  if (!cg.ok || !cg.group) fail("createGroup 失败", JSON.stringify(cg));
  ok(`createGroup 带成员：${gname} memberIds=${cg.group.memberIds.join(",")}`);
  if (cg.group.memberIds.includes(fe.id)) fail("新群不应包含未选成员 ai-fe");

  // ⑤ 拉人：updateGroupMembers 追加 ai-fe
  const merged = [qa.id, fe.id];
  const um = await new Promise((res) => socket.emit("updateGroupMembers", { groupId: cg.group.id, memberIds: merged }, res));
  if (!um.ok) fail("拉人失败", JSON.stringify(um));
  ok(`拉人进群：ai-qa + ai-fe → ${cg.group.id}`);

  // ⑥ 思考过程 trace（真实 LLM：@小满 免工具任务）
  console.log("  … 等待 @小满 回复（真实 LLM，约 30~90s）…");
  const t0 = Date.now();
  socket.emit("send", { groupId: GID, text: "@小满 请只回复两个字：收到" });
  const mt = await waitMsg((m) => m.groupId === GID && m.senderId === "ai-qa" && m.ts > t0 && /收到/.test(m.text || ""), 180000);
  if (!Array.isArray(mt.trace) || mt.trace.length === 0) fail("回复缺少思考过程 trace", JSON.stringify({ has: !!mt.trace, len: mt.trace?.length }));
  ok(`思考过程 trace ${mt.trace.length} 步：${mt.trace.map((t) => t.kind).slice(0, 6).join("/")}${mt.trace.length > 6 ? "…" : ""}`);

  // 清理测试群
  await new Promise((res) => socket.emit("deleteGroup", { groupId: cg.group.id }, res));
  console.log(`\nUIV2-E2E-OK（${step} 步全部通过）`);
  process.exit(0);
};

main().catch((e) => { console.error("\nUIV2-E2E-FAIL:", e.message || e); process.exit(1); });
setTimeout(() => { console.error("GLOBAL TIMEOUT"); process.exit(2); }, 240000);
