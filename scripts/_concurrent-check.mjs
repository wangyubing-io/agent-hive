// 多 agent 并发 E2E：一条消息 @ 两个 agent -> 两条独立事件流并行 -> 两个 done/回复
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:18741/");
const log = (...a) => console.log(...a);

const doneAgents = new Set();
const replies = [];
// 记录每个 agent 的事件时间窗口，用于验证并行
const active = new Map(); // agentId -> { firstTs, lastTs }
const files = [];

const timeout = setTimeout(() => {
  log("TIMEOUT");
  process.exit(1);
}, 420_000);

socket.on("connect", () => {
  socket.emit("send", { text: "@老何 请创建文件 be-concurrent.txt 内容写「后端并发测试」。同时 @小满 请创建文件 qa-concurrent.txt 内容写「测试并发测试」。两位各自完成后一句话回报。" }, (r) => {
    log("send ack:", JSON.stringify(r));
  });
});

socket.on("typing", ({ agentId }) => log("[typing]", agentId));
socket.on("agentEvent", (ev) => {
  const now = Date.now();
  if (!active.has(ev.agentId)) active.set(ev.agentId, { firstTs: now, lastTs: now, count: 0 });
  const a = active.get(ev.agentId);
  a.lastTs = now;
  a.count++;
  if (["turn/start", "turn/end"].includes(ev.type)) log("[event]", ev.agentId, ev.type);
});
socket.on("file", (f) => { files.push(f.name); log("[file]", f.name); });
socket.on("message", (m) => {
  if (m.senderId !== "human") {
    replies.push(m.senderId);
    log("[reply]", m.senderName, ":", String(m.text).slice(0, 80).replace(/\n/g, " / "));
  }
});
socket.on("done", ({ agentId }) => {
  doneAgents.add(agentId);
  log("[done]", agentId, `(${doneAgents.size}/2)`);
  if (doneAgents.size === 2) {
    clearTimeout(timeout);
    // 验证并行：两个 agent 的活动窗口必须重叠
    const ids = [...active.keys()];
    const overlap =
      ids.length === 2 &&
      active.get(ids[0]).firstTs < active.get(ids[1]).lastTs &&
      active.get(ids[1]).firstTs < active.get(ids[0]).lastTs;
    log("--- 活动窗口:", JSON.stringify([...active.entries()].map(([k, v]) => [k, { events: v.count, span: v.lastTs - v.firstTs + "ms" }])));
    log("--- 文件产物:", files.join(", ") || "无");
    const ok = doneAgents.has("ai-be") && doneAgents.has("ai-qa") && replies.length >= 2 && overlap;
    log(ok ? "CONCURRENT-OK" : "CONCURRENT-FAIL " + JSON.stringify({ done: [...doneAgents], replies: replies.length, overlap, ids }));
    process.exit(ok ? 0 : 1);
  }
});
