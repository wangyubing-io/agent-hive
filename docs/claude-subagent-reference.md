# Claude Code Sub-agent 架构调研（agent-hive 参考）

> 结论先行：Claude 的 sub-agent 本质是「**Agent tool + 独立上下文 + 工具白名单 + 单向摘要回传**」的星形编排。
> agent-hive 当前的 lead 分派 + 并行 `runAgentTask` + 各自独立 sessionKey，**骨架上已经等价**；差距在四个具体机制：
> 工具白名单、并行文件冲突隔离（worktree）、按角色的模型路由落地、子任务「只回摘要不回过程」。
> 来源：Anthropic 官方博客《Steering Claude Code》、官方文档《Create custom subagents》、《Subagents in the SDK》（2026-09 查证）。

---

## 一、机制拆解

### 1. 定义层：`.claude/agents/*.md`

Sub-agent 是一个 markdown 文件，YAML frontmatter + 正文（正文=该 subagent 的 system prompt）：

```yaml
---
name: code-reviewer
description: 专注代码质量审查。适合 PR 合并前深度审查。   # 主对话靠它决定何时委派
tools: Read, Grep, Glob, Bash      # 工具白名单（缺省=继承全部）
model: haiku                        # 模型路由（可用便宜模型）
maxTurns: 25
permissionMode: acceptEdits
isolation: worktree                 # 并行文件隔离（见 §3）
background: true                    # 后台运行（见 §4）
---
你是一个经验丰富的 code reviewer……（详细指令放正文，只在 subagent 运行时加载）
```

两个加载层级：`.claude/agents/`（项目级）与 `~/.claude/agents/`（用户级跨项目）。

**关键设计——description 与 body 的分工**：name/description/tools 在**会话启动时**就加载进主上下文（用于委派决策），body 大段指令**只在 subagent 运行时**才进它自己的窗口，**从不进入父对话**。官方明确警告：所有自定义 subagent 的 description 合计超 15k token 会启动告警——描述要短，细节下放 body。

### 2. 调用层：Agent tool（v2.1.63 前叫 Task tool）

主对话通过一次 tool call 委派子任务：

| 参数 | 说明 |
|---|---|
| `subagent_type` | 用哪个 subagent（Explore / Plan / general-purpose / 自定义名） |
| `description` | 3~5 词任务摘要 |
| `prompt` | 详细任务指令——**必须自包含**，因为发出去后不能再追问 |
| `run_in_background` | 异步跑，主对话继续 |
| `model` | 本次调用的模型覆盖 |
| `resume` | 按 agentId 续跑之前的 subagent（保留完整历史） |

执行模型是**无状态单向**的：

- subagent 在**全新独立 context window** 里跑（看不到父对话历史），拿到两样东西：自己的 system prompt + 父写的任务 prompt；
- 跑完后**只回一条最终消息**给父对话（通常是多轮工具调用的汇总）；中间过程全部丢弃，用户看不到，除非父主动转述；
- 无双向通信——发出去就不能追问，所以 prompt 必须一次写清楚；
- 消息流上，subagent 内部消息带 `parent_tool_use_id` 标记，SDK 靠它区分「哪个消息来自哪个 subagent 上下文」；
- 嵌套：subagent 内部可继续委派，官方支持**最多 5 层**；一次消息里发多个 Agent tool call 即**并行**执行。

### 3. 隔离层：并行文件冲突的两档

| 模式 | 行为 | 适用 |
|---|---|---|
| default | 与主对话**共享同一工作目录**，直接读写同一份文件 | 只读调研、或确定无文件冲突 |
| `isolation: worktree` | 每个 subagent 领一个**临时 git worktree**（共享 git 历史、独立文件树），改完不自动影响主目录，分支留给人工 review/合并 | 多 agent 并行改同一批文件、实验性/竞争性方案 |

这是 Claude 解决「A 改 `src/auth.ts` 时 B 也在改它」的答案——不是靠锁，而是靠**物理副本 + 事后合并**。

### 4. 内置 subagent 与模型经济学

| 内置 | 工具 | 模型 | 用途 |
|---|---|---|---|
| Explore | **只读**（禁 Write/Edit） | 继承主对话（capped at Opus） | 代码库探索；会跳过 CLAUDE.md 和 git status 保持轻快 |
| Plan | **只读** | 继承 | plan mode 下的调研，主对话保持只读 |
| general-purpose | 全量 | 继承或 `CLAUDE_CODE_SUBAGENT_MODEL` 强制 | 多步探索+执行 |

模型路由是 subagent 的一等能力：研究/审查类任务路由到 Haiku（成本可降约一个量级），推理重的留给主模型。Agent Teams（实验特性）更把 `coordinationModel`（Team Lead 用强模型）与 `workerModel`（Teammates 用轻模型）拆成两个配置项。

### 5. 使用判据（官方规则）

**用 subagent**：会向主对话倾倒一次性中间结果（搜索结果、日志、文件内容）的边路任务；重复以相同指令 spawn 同类工作者；需要工具权限收紧；需要模型降档。
**不用**：已知路径读文件（直接 Read）、找 `class Foo`（直接 Glob）、2~3 个文件内搜索（直接 Read）——「针状查询」直接干更快。
**多智能体判据**（Anthropic 官方口径）：任务能清晰分解？子任务可并行？错误容忍度高？三者皆「是」才值得上，否则别过度工程化。

---

## 二、与 agent-hive 的对照

| 机制 | Claude Code | agent-hive 现状 | 差距 |
|---|---|---|---|
| 编排拓扑 | 星形：主对话 ↔ subagent，成员间不通信（Agent Teams 实验中才双向） | 星形：lead 拆解 dispatch → 并行 `runAgentTask` → lead 汇总 | **等价** |
| 独立上下文 | 每次调用全新窗口，跑完即弃 | 每 (agent, cwd) 持久 sessionKey（SQLite + 摘要压缩） | agent-hive **更强**（记忆连续）；但缺「一次性无状态 worker」模式，长会话有历史包袱 |
| 回传内容 | 只回一条最终摘要，过程不进父上下文 | 成员完整回复（含 trace）落进群聊；lead 汇总另发 | 群聊展示与「lead 消费的内容」未分离——lead 汇总时会把成员长回复整体塞进自己的上下文 |
| 工具白名单 | 每 subagent 声明 tools 子集（Explore 只读等） | 全员恒等 4 工具（read/write/list/shell），仅路径层面约束 | **缺**——qa 审查类任务其实不该有 write |
| 模型路由 | subagent 级 model 字段 + 全局环境变量 | `agent.llm` 角色级覆盖**已实现**（harness 角色级 > 全局） | 能力在，缺**默认策略**（lead 强模型、成员轻模型）与设置面板入口 |
| 并行文件冲突 | worktree 隔离（物理副本+事后合并） | 绑定目录时全员共享同一 cwd，仅同 (agent,cwd) 串行 | **缺**——不同 agent 并行改同一绑定目录会互相覆盖 |
| 委派决策 | description 驱动自动委派 + @-mention 显式指定 | @ 路由 + lead dispatch（LLM 拆解 JSON） | 等价（agent-hive 的 dispatch 更结构化） |
| 嵌套 | ≤5 层 | 无（成员不能再分派） | 一致（一层就够，防失控） |
| 限流保护 | maxTurns、permissions 继承、后台 agent 预授权后自动拒绝未授权操作 | MAX_RECURSION=100 + 600s 超时 + runChains 串行 | 等价 |
| 任务队列 | Agent Teams 共享任务列表（实验，不持久化，/resume 有丢成员的已知 bug） | 编排看板 + orchestrations.jsonl 落盘重放 | agent-hive **更强**（事件持久化） |

## 三、值得抄的四个点（按性价比排序）

> **落地状态（2026-09-08）**：第 1、2、3 项已实现并端到端验证通过（提交见 git log）；第 4 项暂缓。

### 1. 工具白名单 ✅ 已落地

`AgentDef.tools?: string[]`（模型层聚焦引导，非安全边界——沙箱路径约束才是）：

- `buildSandboxTools(cwd, { allowed })` 按白名单过滤，harness 透传 `agent.tools`；
- 默认生效：**lead（王大锤）只读**——`read_file / list_dir / search_history / search_workspace`，无 `write_file / run_shell`（防总监抢活，对齐 Explore/Plan 只读哲学）；fe/be/qa 缺省全量（qa 的职责包含写测试用例与跑验证，不能只读）；
- systemPrompt 里的工具列表已改为动态生成（白名单过滤后真实剩余的工具）；
- 存量 `data/settings.json` 的老成员档案已做一次迁移（persona 去掉"本人动手写代码"+补 tools）；深合并按字段覆盖，老档案缺 tools 字段时自动继承内置白名单。

### 2. lead 汇总只吃摘要 ✅ 已落地

- 成员子任务 prompt 末尾追加结构化回报要求：`【结果】/【产出】/【风险】`三段、≤500 字；
- lead 汇总 prompt 只吃成员回报，且超长回报头尾裁剪（2400 字上限：头 1000 + 尾 1200 + 略节标记）——群里仍展示全文，只有 lead 的上下文吃摘要；
- 实测：成员回报带三段结构，lead 汇总直接引用成员结论，不再要求重新读文件核对。

### 3. 模型路由默认策略 ✅ 已落地（配置约定）

`agent.llm` 覆盖链路本就存在（角色级 > 全局），约定的用法：**全局默认轻模型（deepseek-v4-flash），lead 单独覆盖强模型（deepseek-v4-pro）**——对应 Claude Agent Teams 的 coordinationModel / workerModel 分离。在 `data/settings.json` 的对应成员上加 `"llm": {"model": "deepseek-v4-pro"}` 即可，零代码。

### 4. 并行文件冲突：worktree 隔离（大改动，先记录）

绑定目录 + 多成员并行写是当前唯一的真冲突面。Claude 的答案是 per-task git worktree + 事后合并。agent-hive 短期可做两件便宜事：

- lead dispatch 时**按目录前缀分组**：同目录前缀的子任务不并行（排进同一条 runChain），不同前缀才并行——把冲突面从「整个工作区」缩到「同目录」；
- 长期才考虑真 worktree（需要 git 依赖 + 合并 UI，成本高，等真实痛点出现再上）。

---

## 四、顺带的边界认知

- **subagent ≠ 更快**：加速来自任务图的并行分支，不是堆 agent 数；强依赖任务（A 输出=B 输入）并行反而更慢（协调开销）。
- **官方也承认多智能体是少数场景**：能分解/可并行/高容错三条件齐了才上。
- Claude 三层并行架构：Main Session → Sub-agents（单向、星形）→ Agent Teams（双向、共享任务列表、实验性、teammates ≤10、队列不持久化、/resume 丢成员）——agent-hive 的编排看板已经覆盖 Agent Teams 的核心价值（共享任务状态+事件持久化），且比它稳。

> 延伸：Codex / DeepSeek / 开源框架（LangGraph Supervisor、CrewAI、AutoGen）的对照可另开一篇，本篇聚焦 Claude。

---

## 五、Agent Teams 专项调研（2026-09-08 补充）

Claude Code 4.6 同期上线的 Agent Teams（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 开启）：真正的多实例协同——队友各有独立上下文窗口，**可直接互发消息**（不只向主 agent 汇报）。

### 核心机制

| 机制 | Claude 实现 | agent-hive 现状 / 可抄性 |
|---|---|---|
| **共享任务列表** | JSON 文件任务队列，三态（pending/in-progress/completed），`blockedBy` 依赖声明，完成自动解锁下游；**文件锁认领**（写 `current_tasks/<id>.txt` 防重复认领） | 编排看板已覆盖状态跟踪+落盘重放；`blockedBy` 依赖分波执行值得抄（dispatch 加 dependsOn 字段，拓扑分波并行），中改动 |
| **Mailbox 互信通信** | 每队友独立收件箱 `~/.claude/teams/{name}/inboxes/{agent}.json`，SendMessage 直发/Broadcast 群发，结构化消息类型（shutdown_request、权限上浮） | agent-hive 成员目前只对群说话；可抄「成员 @成员 求助」的跨 agent 转发，但会放大 token 成本，暂缓 |
| **三种执行模型** | InProcessTeammate（AsyncLocalStorage 同进程隔离）/ LocalAgentTask（本地后台进程）/ RemoteAgentTask（云容器） | agent-hive 全部同进程（langchain 编排），无此诉求 |
| **worktree 隔离** | per-teammate git worktree（独立工作目录/暂存区/HEAD，共享 objects/refs），五分支并行后走 PR 合并 | 同第 4 节：绑定目录+多成员并行写才有痛点，暂缓 |
| **forked agent 模式** | 所有 agent 共享 cache-safe prompt 前缀，实测 **92% prompt cache 复用**（5 个并行 agent 成本≈1 个） | 启示：保持各成员 systemPrompt 前缀结构一致（ persona 之外的公共段落固定措辞），对 provider 缓存友好 |
| **防递归** | fork 出的子代看得到 AgentTool 但拒绝再 fork | agent-hive 成员本来无派调度，无此风险 |

### 教训与边界（官方踩坑记录）

- **36.8 GB 内存事故**：内部 292 agent 测试吃掉 36.8GB → 加 `TEAMMATE_MESSAGES_UI_CAP=50`。启示：任何「消息队列/UI 列表」都要封顶。
- **lead 上下文不遗传**：teammates 是 peers 不是 children，只加载项目上下文（CLAUDE.md/MCP/skills），不带 lead 的对话历史——与 agent-hive 的 seedContext 哲学一致（成员只拿种子摘要+检索，不吃 lead 全history）。
- **选型口径**：subagent=要结果（单向、省 token），teams=要讨论（双向、token 贵数倍）；顺序任务/同文件改动/强依赖场景官方明确建议单会话。
