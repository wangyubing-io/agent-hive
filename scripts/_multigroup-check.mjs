// 多群会话管理 E2E：
// 1) 连接拿群列表 -> joinGroup g-dev 拿历史
// 2) createGroup B群 -> 切入 -> 空历史
// 3) 在 B 群发 @老何 任务（免工具快速回复）-> 回复带 groupId=B
// 4) 另一连接留在 g-dev 发消息 -> B 群连接收不到（房间隔离）
// 5) 落盘校验：messages/<B>.jsonl 有消息，g-dev.jsonl 无 B 群消息
import { io } from "socket.io-client";
import { readFileSync } from "node:fs";

const log = (...a) => console.log(...a);
const A = io("http://127.0.0.1:18741/"); // 将切换到 B 群
const B = io("http://127.0.0.1:18741/"); // 留在 g-dev

let bGroupId = null;
const seenByA = { messages: [], agentEvents: 0, gDevLeaks: 0 };
let aDone = false, bReceivedOwn = false;

const timeout = setTimeout(() => { log("TIMEOUT"); process.exit(1); }, 420_000);

const step = (n, ok, detail = "") => {
  log(`[step${n}] ${ok ? "PASS" : "FAIL"} ${detail}`);
  if (!ok) process.exit(1);
};

A.on("groups", (list) => {
  if (bGroupId) return; // 广播刷新忽略
  step(1, Array.isArray(list) && list.some((g) => g.id === "g-dev"), `groups=${list.map((g) => g.name).join(",")}`);
  A.emit("joinGroup", { groupId: "g-dev" }, () => {});
});

A.on("history", (list) => {
  if (bGroupId) return; // 只关心第一次（g-dev）
  step(2, Array.isArray(list), `g-dev history ${list.length} 条`);
  A.emit("createGroup", { name: "E2E-B群" }, (r) => {
    step(3, !!(r && r.ok && r.group && r.group.id), `created ${r.group && r.group.id}`);
    bGroupId = r.group.id;
    A.emit("joinGroup", { groupId: bGroupId });
  });
});

let bHistoryChecked = false;
A.on("history", (list) => {
  if (!bGroupId || bHistoryChecked) return;
  bHistoryChecked = true;
  step(4, list.length === 0, `B 群初始历史 ${list.length} 条（应为 0）`);
  // B 群发免工具任务
  A.emit("send", { groupId: bGroupId, text: "@老何 请直接回复「B群收到」，本轮不要使用任何工具，直接文字回复。" }, (r) => {
    step(5, !!(r && r.ok), `send ack ${JSON.stringify(r)}`);
  });
  // 同时让连接 B 在 g-dev 发一条（应被房间隔离，A 不该收到）
  B.emit("joinGroup", { groupId: "g-dev" });
  setTimeout(() => {
    B.emit("send", { groupId: "g-dev", text: "你好" }, (r) => {
      step(6, !!(r && r.ok), "g-dev 发送成功（你好不触发 agent）");
    });
  }, 300);
});

A.on("message", (m) => {
  seenByA.messages.push({ groupId: m.groupId, sender: m.senderId });
  if (m.groupId === "g-dev") seenByA.gDevLeaks++;
  if (m.senderId === "ai-be" && m.groupId === bGroupId) log("[A 收到 B 群回复]", String(m.text).slice(0, 60));
});
A.on("agentEvent", (ev) => {
  if (ev.groupId === bGroupId) seenByA.agentEvents++;
  if (ev.groupId === "g-dev") seenByA.gDevLeaks++;
});
A.on("done", (ev) => {
  if (ev.groupId !== bGroupId) return;
  aDone = true;
  log(`[A] B 群 done；A 收到 g-dev 泄漏事件 ${seenByA.gDevLeaks} 个`);
  step(7, seenByA.agentEvents > 0, `B 群事件流 ${seenByA.agentEvents} 条`);
  step(8, seenByA.gDevLeaks === 0, "A 未收到任何 g-dev 事件（房间隔离）");
  B.emit("joinGroup", { groupId: "g-dev" });
  // 校验落盘
  setTimeout(() => {
    const dev = readFileSync("data/messages/g-dev.jsonl", "utf8");
    const bMsgs = readFileSync(`data/messages/${bGroupId}.jsonl`, "utf8");
    step(9, bMsgs.includes("B群收到") || bMsgs.includes(bGroupId), "B 群消息已落盘");
    step(10, !bMsgs.includes("你好"), "g-dev 的「你好」没有混进 B 群");
    step(11, dev.includes("你好"), "「你好」落在 g-dev");
    clearTimeout(timeout);
    log("MULTI-GROUP-OK");
    process.exit(0);
  }, 500);
});
