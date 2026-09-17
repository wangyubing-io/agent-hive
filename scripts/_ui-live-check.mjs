// 实时 UI 链路校验：连接 agent-hive 服务端，发一条 @老何 任务，
// 记录 typing/agentEvent/message/done 事件序列，验证 UI 消费的事件流完好。
import { io } from "socket.io-client";

const URL = "http://127.0.0.1:18741";
const socket = io(URL, { transports: ["websocket"] });

let nMsg = 0;
const evSeq = [];

socket.on("connect", () => {
  console.log("[client] connected");
  socket.emit("send", {
    text: "@老何 帮我在当前工作目录执行命令 pwd，并把输出结果用一句话告诉我。",
  }, (r) => console.log("[client] ack", JSON.stringify(r)));
});

socket.on("history", (l) => console.log("[client] history msgs:", Array.isArray(l) ? l.length : l));
socket.on("agents", (a) => console.log("[client] agents:", (a || []).map((x) => x.id).join(",")));

socket.on("typing", (p) => { evSeq.push("typing"); console.log("[ev] typing", JSON.stringify(p)); });
socket.on("agentEvent", (p) => {
  evSeq.push("agentEvent:" + p.type);
  console.log("[ev] agentEvent", p.type, JSON.stringify(p.data || {}).slice(0, 220));
});
socket.on("message", (m) => {
  nMsg++;
  console.log("[ev] message from", m.senderName, ":", String(m.text).slice(0, 120));
});
socket.on("done", (p) => {
  console.log("[ev] done", JSON.stringify(p));
  console.log("=== SUMMARY ===\n  messages:", nMsg, "\n  event seq:", evSeq.join(" → "));
  const ok = nMsg >= 1 && evSeq.includes("agentEvent:tool/call");
  console.log(ok ? "UI-CHAIN-OK" : "UI-CHAIN-INCOMPLETE");
  process.exit(ok ? 0 : 2);
});

setTimeout(() => { console.log("TIMEOUT waiting done"); process.exit(3); }, 180_000);
