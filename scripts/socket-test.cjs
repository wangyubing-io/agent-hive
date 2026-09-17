// 端到端 socket 验证：连接服务、发消息、等 AI 回复后退出
const { io } = require("socket.io-client");

const s = io("http://127.0.0.1:18741", { transports: ["websocket"], reconnection: false, timeout: 8000 });

let step = "connect";
s.on("connect", () => {
  console.log("[socket] connected");
});
s.on("history", (list) => {
  console.log(`[socket] history=${list.length} 条`);
  if (step === "connect") {
    step = "send";
    const text = "@小满 帮我检查沙箱里有没有叫 sandbox-check 的目录，没有就创建一个并在里面生成 notes.txt 写一行说明。";
    console.log(`[human] ${text}`);
    s.emit("send", { text }, (r) => {
      console.log("[socket] ack:", JSON.stringify(r));
    });
  }
});
s.on("typing", ({ agentName }) => {
  console.log(`[socket] ${agentName} 思考中…`);
});
s.on("message", (m) => {
  console.log(`[${m.senderName}] ${(m.text || "").slice(0, 120)}`);
  if (m.senderId !== "human") {
    // AI 回复完成，检查产物后退出
    setTimeout(() => process.exit(0), 1500);
  }
});
s.on("connect_error", (e) => {
  console.error("[socket] connect_error:", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.error("timeout: 120s 无完成");
  process.exit(2);
}, 120000);
