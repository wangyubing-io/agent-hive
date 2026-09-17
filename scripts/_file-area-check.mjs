// 群文件区端到端验证：@老何 产出一个文件 -> file 事件 -> /api/files/:id/download 可下载
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:18741/");
const log = (...a) => console.log(...a);

const events = [];
let fileId = null;

const timeout = setTimeout(() => {
  log("TIMEOUT: 未在 5 分钟内完成");
  process.exit(1);
}, 300_000);

socket.on("connect", () => {
  const fname = `live-demo-${Date.now().toString(36)}.md`;
  socket.emit("send", { text: `@老何 请在当前目录创建文件 ${fname}，内容写上「群文件区端到端测试」和今天的日期，然后简单回复一句。` }, (r) => {
    log("send ack:", JSON.stringify(r));
  });
});

socket.on("files", (list) => log("[files history]", list.length, "个文件"));
socket.on("file", (f) => {
  fileId = f.id;
  log("[file 事件]", JSON.stringify(f));
});
socket.on("message", (m) => {
  if (m.senderId !== "human") log("[message]", m.senderName, ":", String(m.text).slice(0, 120).replace(/\n/g, " / "));
});
socket.on("done", async ({ agentId }) => {
  log("[done]", agentId);
  if (!fileId) {
    log("FAIL: run 结束但没有 file 事件");
    process.exit(1);
  }
  // 验证下载
  try {
    const res = await fetch(`http://127.0.0.1:18741/api/files/${fileId}/download`);
    const body = await res.text();
    log("[download]", res.status, res.headers.get("content-type"), "| bytes:", body.length);
    log("[download body]:", body.replace(/\n/g, " ⏎ ").slice(0, 200));
    // 验证路径穿越防护
    const res2 = await fetch("http://127.0.0.1:18741/api/files/f_nonexistent/download");
    log("[traversal/404 check]", res2.status === 404 ? "OK (404)" : "FAIL " + res2.status);
    clearTimeout(timeout);
    log(fileId && res.status === 200 ? "FILE-AREA-OK" : "FILE-AREA-FAIL");
    process.exit(0);
  } catch (e) {
    log("download error:", e.message);
    process.exit(1);
  }
});
socket.on("agentEvent", (ev) => {
  if (["turn/start", "turn/end", "run/error", "timeout"].includes(ev.type)) log("[agentEvent]", ev.type, JSON.stringify(ev.data || {}));
});
