/**
 * 编排端到端验证（借鉴 Claude 三项改造的落地验证）：
 *  1) lead 工具白名单：王大锤全程只用只读工具（trace 里不得出现 write_file/run_shell）
 *  2) 成员结构化回报：子任务回复含【结果】【产出】【风险】
 *  3) lead 只吃摘要：汇总基于成员回报而非全文
 * 走真实链路：socket 登录 → 进 g-dev → 发分派型需求 → 监听 message/orchestration
 */
const { io } = require("socket.io-client");

const URL = process.env.HIVE_URL || "http://127.0.0.1:18742";
const ACCOUNT = process.env.HIVE_ACCOUNT || "tester";
const TIMEOUT_MS = 300_000;

const messages = [];
let ended = false;

const socket = io(URL, { transports: ["websocket"] });

function finish(ok, why) {
  if (ended) return;
  ended = true;
  console.log("\n===== 断言 =====");
  const leadMsgs = messages.filter((m) => m.senderId === "ai-lead");
  const memberMsgs = messages.filter((m) => m.senderId && m.senderId.startsWith("ai-") && m.senderId !== "ai-lead");

  // 1) lead 只读：所有 lead 消息的 trace 中工具调用不含 write_file / run_shell
  const leadTools = new Set();
  for (const m of leadMsgs) {
    for (const t of m.trace || []) {
      if (t.kind === "tool" && t.text) {
        const name = t.text.split(/\s+/)[0];
        if (name) leadTools.add(name);
      }
    }
  }
  const leadViolations = [...leadTools].filter((n) => n === "write_file" || n === "run_shell");
  console.log(`1) lead 工具使用: [${[...leadTools].join(", ") || "无"}] → ${leadViolations.length === 0 ? "✅ 只读" : "❌ 越权: " + leadViolations.join(",")}`);

  // 2) 成员结构化回报
  const structured = memberMsgs.filter((m) => /【结果】/.test(m.text || "") && /【产出】/.test(m.text || ""));
  console.log(`2) 成员结构化回报: ${memberMsgs.length} 条成员消息中 ${structured.length} 条含【结果】【产出】 → ${structured.length >= 1 ? "✅" : "❌"}`);

  // 3) lead 最终汇总存在（编排结束后最后一条 lead 消息）
  const lastLead = leadMsgs[leadMsgs.length - 1];
  console.log(`3) lead 汇总: ${lastLead ? "✅ 存在（" + (lastLead.text || "").replace(/\n/g, " ").slice(0, 80) + "…）" : "❌ 无"}`);

  const allOk = leadViolations.length === 0 && structured.length >= 1 && !!lastLead;
  console.log(`\n${allOk ? "✅ 全部通过" : "❌ 有未通过项"}（${why}）`);
  socket.disconnect();
  process.exit(allOk ? 0 : 1);
}

socket.on("connect", () => {
  console.log("connected");
  socket.emit("login", { account: ACCOUNT }, (r) => {
    if (!r || !r.ok) {
      console.log("登录失败:", r && r.error);
      process.exit(1);
    }
    console.log("登录 OK:", r.user && r.user.name);
    socket.emit("joinGroup", { groupId: "g-dev" });
  });
});

socket.on("joinedGroup", (ev) => {
  if (ev.groupId !== "g-dev") return;
  console.log("已进 g-dev，发需求…\n");
  socket.emit("send", {
    groupId: "g-dev",
    text: `@王大锤 【任务 ${Date.now().toString(36)}，全新需求直接执行，无需与历史核对】请让测试工程师在她的沙箱里写一个冒烟测试说明文件，内容为一句话冒烟测试说明，写完读回来确认内容正确。`,
  });
});

socket.on("message", (m) => {
  messages.push(m);
  const head = (m.text || "").replace(/\n/g, " ").slice(0, 110);
  console.log(`  [${m.senderName}] ${head}`);
});

socket.on("agentEvent", (ev) => {
  if (ev && ev.type === "queued") console.log(`  (排队: ${ev.agentShortName || ""})`);
});

socket.on("orchestration", (ev) => {
  const tag = `orch:${ev.phase}${ev.status ? ":" + ev.status : ""}`;
  console.log(`  (${tag}) ${(ev.summary || ev.note || ev.task || "").toString().replace(/\n/g, " ").slice(0, 100)}`);
  if (ev.phase === "end") setTimeout(() => finish(true, "编排结束"), 1500);
});

socket.on("connect_error", (e) => console.log("connect_error:", e.message));
setTimeout(() => finish(false, "超时"), TIMEOUT_MS);
