/**
 * updateAgent 扩展字段验证（tools / llmModel）：
 * 1) 设 be 的模型覆盖 → agents 广播含 llm.model、settings.json 落盘
 * 2) 设 qa 的工具白名单 → 落档正确
 * 3) 清空模型覆盖（空串）→ llm 移除
 * 4) 解除白名单（null）→ tools 移除
 */
const { io } = require("socket.io-client");
const socket = io(process.env.HIVE_URL || "http://127.0.0.1:18742", { transports: ["websocket"] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let agents = [];

function assert(cond, label) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) process.exitCode = 1;
}

socket.on("agents", (list) => { agents = list; });

socket.on("connect", () => {
  socket.emit("login", { account: process.env.HIVE_ACCOUNT || "tester" }, async (r) => {
    if (!r || !r.ok) { console.log("登录失败:", r && r.error); process.exit(1); }

    // 1) 模型覆盖
    socket.emit("updateAgent", { id: "ai-be", llmModel: "deepseek-v4-pro" }, async (r1) => {
      await sleep(300);
      const be = agents.find((a) => a.id === "ai-be");
      assert(r1 && r1.ok && be && be.llm && be.llm.model === "deepseek-v4-pro", `模型覆盖生效（广播: ${be && be.llm && be.llm.model}）`);

      // 2) 工具白名单
      socket.emit("updateAgent", { id: "ai-qa", tools: ["read_file", "list_dir", "search_history"] }, async (r2) => {
        await sleep(300);
        const qa = agents.find((a) => a.id === "ai-qa");
        assert(r2 && r2.ok && Array.isArray(qa && qa.tools) && qa.tools.join(",") === "read_file,list_dir,search_history", `白名单生效（${qa && qa.tools && qa.tools.join(",")}）`);

        // 3) 清空模型覆盖
        socket.emit("updateAgent", { id: "ai-be", llmModel: "" }, async (r3) => {
          await sleep(300);
          const be2 = agents.find((a) => a.id === "ai-be");
          assert(r3 && r3.ok && !(be2 && be2.llm && be2.llm.model), `清空模型覆盖（llm=${JSON.stringify(be2 && be2.llm)}）`);

          // 4) 解除白名单
          socket.emit("updateAgent", { id: "ai-qa", tools: null }, async (r4) => {
            await sleep(300);
            const qa2 = agents.find((a) => a.id === "ai-qa");
            assert(r4 && r4.ok && !(qa2 && qa2.tools), `解除白名单（tools=${JSON.stringify(qa2 && qa2.tools)}）`);

            // 5) 持久化确认（settings.json 由 saveSettings 同步落盘）
            const fs = require("fs");
            const s = JSON.parse(fs.readFileSync("data/settings.json", "utf8"));
            const beS = s.agents.find((a) => a.id === "ai-be");
            const qaS = s.agents.find((a) => a.id === "ai-qa");
            assert(!beS.llm && !qaS.tools, "settings.json 持久化一致");

            // 6) lead 白名单未被误动（内置只读约束仍在）
            assert(Array.isArray(s.agents.find((a) => a.id === "ai-lead").tools), "lead 只读白名单未受影响");
            socket.disconnect();
            process.exit(process.exitCode || 0);
          });
        });
      });
    });
  });
});
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 60_000);
