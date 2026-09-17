/**
 * 依赖分波 e2e（Agent Teams blockedBy 借鉴项验证）：
 * 发一个天然带依赖的需求（先写接口文档 → 测试基于文档写要点），
 * 断言：1) dispatch 分波不同（be 波 0、qa 波 1）；2) qa 的启动时间晚于 be 的完成时间。
 */
const { io } = require("socket.io-client");

const URL = process.env.HIVE_URL || "http://127.0.0.1:18742";
const ACCOUNT = process.env.HIVE_ACCOUNT || "tester";
const TIMEOUT_MS = 360_000;

const taskEvents = []; // {agent, status, ts}
let dispatchTasks = null;
let ended = false;

const socket = io(URL, { transports: ["websocket"] });

function finish() {
  if (ended) return;
  ended = true;
  console.log("\n===== 断言 =====");
  const beDone = taskEvents.find((e) => e.agent === "ai-be" && e.status === "done");
  const qaRun = taskEvents.find((e) => e.agent === "ai-qa" && e.status === "running");
  const beWave = dispatchTasks?.find((t) => t.agentId === "ai-be")?.wave;
  const qaWave = dispatchTasks?.find((t) => t.agentId === "ai-qa")?.wave;
  console.log("dispatch 分波:", JSON.stringify(dispatchTasks?.map((t) => `${t.agentId}:wave${t.wave}`)));

  let ok = true;
  if (beWave !== undefined && qaWave !== undefined && qaWave > beWave) {
    console.log(`1) 分波正确（老何 wave${beWave} → 小满 wave${qaWave}） ✅`);
  } else {
    console.log(`1) 分波信息（老何 wave${beWave} / 小满 wave${qaWave}）${qaWave > beWave ? " ✅" : " ❌ 未形成依赖波"}`);
    ok = false;
  }
  if (beDone && qaRun && qaRun.ts > beDone.ts) {
    console.log(`2) 时序正确：小满启动(${qaRun.ts}) 晚于 老何完成(${beDone.ts}) ✅`);
  } else {
    console.log(`2) 时序（老何done=${beDone?.ts} / 小满running=${qaRun?.ts}）❌`);
    ok = false;
  }
  console.log(ok ? "\n✅ 依赖分波验证通过" : "\n❌ 未通过");
  socket.disconnect();
  process.exit(ok ? 0 : 1);
}

socket.on("connect", () => {
  socket.emit("login", { account: ACCOUNT }, (r) => {
    if (!r || !r.ok) {
      console.log("登录失败:", r && r.error);
      process.exit(1);
    }
    socket.emit("joinGroup", { groupId: "g-dev" });
  });
});

socket.on("joinedGroup", (ev) => {
  if (ev.groupId !== "g-dev") return;
  console.log("已进 g-dev，发依赖型需求…\n");
  const runTag = Date.now().toString(36); // 唯一标记：防 lead 检索到历史里做过同款任务而停下来向真人确认
  socket.emit("send", {
    groupId: "g-dev",
    text: `@王大锤 【任务 ${runTag}，全新需求直接执行，无需与历史核对】请老何先在他的沙箱写一份 api-spec-${runTag}.txt（三个接口各一句话说明），小满必须等这份文档完成后，基于文档内容写 test-points-${runTag}.txt 测试要点。顺序不能颠倒。`,
  });
});

socket.on("message", (m) => {
  console.log(`  [${m.senderName}] ${(m.text || "").replace(/\n/g, " ").slice(0, 100)}`);
});

socket.on("orchestration", (ev) => {
  if (ev.phase === "task") {
    taskEvents.push({ agent: ev.agentId, status: ev.status, ts: ev.ts });
    console.log(`  (task:${ev.status} ${ev.agentId})`);
  } else if (ev.phase === "dispatch") {
    dispatchTasks = ev.tasks;
    console.log(`  (dispatch 分波: ${ev.tasks.map((t) => t.agentId + ":wave" + t.wave).join(" | ")})`);
  } else if (ev.phase === "end") {
    setTimeout(finish, 1500);
  }
});

socket.on("connect_error", (e) => console.log("connect_error:", e.message));
setTimeout(() => finish(), TIMEOUT_MS);
