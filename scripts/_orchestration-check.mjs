// lead 编排 E2E：丢一个含两类工作的需求（不带任何 @/角色关键字）
// 期望链路：王大锤拆解计划（干净文本，无 dispatch 块）→ 成员并行执行各自子任务 → 王大锤汇总
// 另断言 orchestration 事件序列：plan → dispatch(tasks) → task(running→done/error) → summary(running→done) → end
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:18741/");
const log = (...a) => console.log(...a);

const messages = []; // {senderId, text, ts}
const orchEvents = []; // orchestration 事件（按 runId）
let finished = false;

const timeout = setTimeout(() => { log("TIMEOUT"); dump(); process.exit(1); }, 540_000);

function dump() {
  for (const m of messages) log("  >", m.senderId, "|", String(m.text).slice(0, 100).replace(/\n/g, " / "));
  log("  orch events:", JSON.stringify(orchEvents.map((e) => `${e.phase}:${e.status || (e.tasks ? e.tasks.length + "tasks" : "")}`)));
}

socket.on("connect", () => {
  socket.emit("joinGroup", { groupId: "g-dev" }, () => {});
});

let joined = false;
socket.on("history", () => {
  if (joined) return;
  joined = true;
  socket.emit("send", { groupId: "g-dev", text: "我要做一个记账小工具：需要有人定数据接口协议文档，另有人出页面布局方案。请团队安排。" }, (r) => {
    log("send ack:", JSON.stringify(r));
  });
});

socket.on("message", (m) => {
  if (m.groupId !== "g-dev" || m.senderId === "human") return;
  messages.push(m);
  log("[msg]", m.senderName, ":", String(m.text).slice(0, 70).replace(/\n/g, " / "));
  check();
});

socket.on("orchestration", (ev) => {
  if (ev.groupId !== "g-dev") return;
  orchEvents.push(ev);
  log("[orch]", ev.phase, ev.status || (ev.tasks ? `${ev.tasks.length} 个子任务` : "") || "");
  check();
});

socket.on("done", () => check());

function check() {
  if (finished) return;
  const leadMsgs = messages.filter((m) => m.senderId === "ai-lead");
  const memberMsgs = messages.filter((m) => m.senderId !== "ai-lead");
  const last = messages[messages.length - 1];
  const orchEnd = orchEvents.find((e) => e.phase === "end" && e.ok);
  const done =
    leadMsgs.length >= 2 && memberMsgs.length >= 1 && last && last.senderId === "ai-lead" && orchEnd;
  if (!done) return;
  // 稍等片刻确认没有后续消息
  setTimeout(() => {
    finished = true;
    clearTimeout(timeout);
    const planText = leadMsgs[0].text;
    const summaryText = leadMsgs[leadMsgs.length - 1].text;
    const okMsg =
      !/```dispatch/.test(planText) && // 计划里不能有裸 dispatch 块
      memberMsgs.length >= 1 &&
      leadMsgs.length >= 2;
    // orchestration 事件链断言
    const phases = orchEvents.map((e) => e.phase);
    const dispatch = orchEvents.find((e) => e.phase === "dispatch");
    const tasks = dispatch?.tasks || [];
    const taskRunning = orchEvents.filter((e) => e.phase === "task" && e.status === "running");
    const taskDone = orchEvents.filter((e) => e.phase === "task" && e.status === "done");
    const summaryRun = orchEvents.find((e) => e.phase === "summary" && e.status === "running");
    const summaryDone = orchEvents.find((e) => e.phase === "summary" && e.status === "done");
    const okOrch =
      phases[0] === "plan" &&
      !!dispatch && tasks.length >= 1 &&
      dispatch.plan && !/```dispatch/.test(dispatch.plan) &&
      taskRunning.length >= 1 && taskDone.length >= 1 &&
      taskDone.length + orchEvents.filter((e) => e.phase === "task" && e.status === "error").length >= tasks.length &&
      !!summaryRun && !!summaryDone &&
      phases[phases.length - 1] === "end";
    log(`--- 王大锤 ${leadMsgs.length} 条（计划+汇总），成员 ${memberMsgs.length} 条（${memberMsgs.map((m) => m.senderName).join("、")}）`);
    log(`--- orchestration 事件 ${orchEvents.length} 条: plan → dispatch(${tasks.length}) → running×${taskRunning.length}/done×${taskDone.length} → summary → end`);
    log(okMsg && okOrch ? "ORCHESTRATION-OK" : `ORCHESTRATION-FAIL (msg=${okMsg} orch=${okOrch})`);
    if (!okOrch) dump();
    process.exit(okMsg && okOrch ? 0 : 1);
  }, 5000);
}
