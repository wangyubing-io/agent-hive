// 未读红点契约 E2E：
// A 活跃在 g-dev；B 新建群 C 并在 C 里跑一个 @老何 免工具任务。
// 关键契约：A 必须能收到 C 群的消息事件（全量房间）——这是客户端未读计数的前提。
import { io } from "socket.io-client";

const log = (...a) => console.log(...a);
const A = io("http://127.0.0.1:18741/");
const B = io("http://127.0.0.1:18741/");

let cGroupId = null, aJoinedDev = false, bDone = false, cReplies = 0;
const unreadSim = new Map(); // 模拟客户端未读计数逻辑

const timeout = setTimeout(() => { log("TIMEOUT"); process.exit(1); }, 420_000);
const step = (n, ok, d = "") => { log(`[step${n}] ${ok ? "PASS" : "FAIL"} ${d}`); if (!ok) process.exit(1); };

A.on("groups", (list) => {
  step(1, Array.isArray(list) && list.some((g) => g.id === "g-dev") && list.some((g) => typeof g.lastText === "string"), `群列表带 lastText: ${list.filter(g=>g.lastText).length}/${list.length} 群有预览`);
  A.emit("joinGroup", { groupId: "g-dev" }); // A 活跃在 g-dev
});

A.on("history", () => {
  if (aJoinedDev) return;
  aJoinedDev = true;
  step(2, true, "A 已活跃在 g-dev");
  B.emit("createGroup", { name: "未读测试群" }, (r) => {
    step(3, !!(r && r.ok && r.group), "B 建群成功");
    cGroupId = r.group.id;
    B.emit("joinGroup", { groupId: cGroupId }, () => {});
    setTimeout(() => {
      B.emit("send", { groupId: cGroupId, text: "@老何 请直接回复「未读测试OK」，不要使用工具。" }, (r2) => {
        step(4, !!(r2 && r2.ok), "C 群发送成功");
      });
    }, 300);
  });
});

// A 的视角：模拟 UI 的未读逻辑
A.on("message", (m) => {
  if (m.groupId === "g-dev") return; // A 活跃群正常渲染
  if (m.groupId === cGroupId && m.senderId !== "human") {
    cReplies++;
    unreadSim.set(m.groupId, (unreadSim.get(m.groupId) || 0) + 1);
    log(`[A 视角] C 群 agent 回复已收到（未读+1 -> ${unreadSim.get(m.groupId)}）:`, String(m.text).slice(0, 30));
  }
});

A.on("done", (ev) => {
  if (ev.groupId !== cGroupId) return;
  bDone = true;
  step(5, cReplies >= 1, `A 收到 C 群 agent 回复 ${cReplies} 条（未读计数可行）`);
  step(6, (unreadSim.get(cGroupId) || 0) >= 1, `未读模拟计数=${unreadSim.get(cGroupId)}`);
  // A 切到 C 群，应拿到历史（含 agent 回复）
  A.emit("joinGroup", { groupId: cGroupId }, () => {});
});

let aHistoryC = false;
A.on("history", (list) => {
  if (!cGroupId || aHistoryC || bDone === false) return;
  aHistoryC = true;
  const hasReply = list.some((m) => m.groupId === cGroupId && m.senderId === "ai-be");
  step(7, hasReply, `A 切入 C 群后历史含 agent 回复（${list.length} 条）`);
  clearTimeout(timeout);
  log("UNREAD-CONTRACT-OK");
  process.exit(0);
});
