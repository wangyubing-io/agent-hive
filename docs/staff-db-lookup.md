# 员工通讯录与登录（agent-hive 直查 uc_staff）

> 结论：通讯录「真人同事」= 服务端直查员工库 MySQL `uc_staff` 的**全部在职员工**；
> 「域账号登录」用同一份数据校验身份。不再依赖 om-user HTTP 服务，也没有"加好友"概念。
> 连接**全部走环境变量**（见 `.env.example`）；未配置 `STAFF_DB_HOST` 时该能力自动停用。

## 数据来源与表

| 项 | 值 |
|---|---|
| 库 | 由 `STAFF_DB_NAME` 指定（MySQL 5.7+，地址由 `STAFF_DB_HOST`/`STAFF_DB_PORT` 指定） |
| 表 | `uc_staff`（默认，可由 `STAFF_DB_TABLE` 覆盖） |
| 关键列 | `domain_account`（域账号，**纯用户名**小写）、`cn_name`（中文名）、`staff_name`、`department_name`、`post_title`、`staff_no`（工号）、`is_active`、`status`、`dimission_date`（离职时间，NULL/未来=在职） |

注意：
- `domain_account` 是纯用户名，**不带域前缀**（如 `zhangsan1`，非 `corp\zhangsan1`）。脏数据偶见离职记录里夹日期（如 `lisi1998-06-30`），必须过滤。
- 显示名优先 `cn_name`（个别为 `无` 时回落 `staff_name`）。
- 真人成员 id 规约：`h_<纯域账号>` 表示具体某位同事；工作区 `memberIds` 里的 `human` 是"开放位"——**含 `human` 的工作区 = 全员真人可见（开放工作区），不含 `human` 的工作区 = 私有工作区（仅 `h_*` 成员可见）**。

## 两个用途的 SQL

**1. 通讯录全量列表**（首次连接/登录时服务端拉一次并缓存，成功后广播 `staff` 事件）

```sql
SELECT cn_name, staff_name, domain_account, department_name, post_title, staff_no
FROM `uc_staff`
WHERE is_active = 1 AND status = 1 AND domain_account <> ''
  AND (dimission_date IS NULL OR dimission_date > NOW())
ORDER BY domain_account;
```

**2. 登录/单查校验**（内存缓存命中优先，缓存未就绪先刷新全量；SQL 相同过滤 + 精确匹配 `domain_account = :da LIMIT 1`）

用 `zhangsan1` 验证：
```
name=张三  title=技术中心 · 工程师  domainAccount=zhangsan1
```
离职/脏数据（如 `lisi1998-06-30`）与不存在账号 → 「未找到在职员工」。

## agent-hive 侧实现

- 数据层：`apps/server/src/staffDb.ts`
  - `listActiveStaff()`：全量在职列表（通讯录真人区）
  - `lookupStaff()`：按纯账号查单个在职（保留备用）
  - `staffDbStatus()`：连接/状态自检
  - mysql2 懒加载（`import("mysql2/promise")`），驱动缺失或库不可达**只报错不拖垮 server**；失败 30s 冷却。
- 服务层：`apps/server/src/index.ts`
  - 内存缓存 `staffCache` + `refreshStaff()`：首个客户端连接时拉全量，成功后按各端身份重推通讯录与工作区列表。
  - **登录签发会话令牌**：socket `login {account}` → `resolveLogin` 在职校验 → 服务端签发 64 位随机 `token`（7 天有效，落盘 `data/sessions.json`，重启不失效）→ ack 返回 `{user, token}` + `me` 事件。
  - **握手恢复**：前端 `io({auth:{token}})` 连接即恢复身份（不再用 URL 传域账号）；token 无效/过期 → `me:null`，回到登录门禁。
  - **同账号单活**：同一域账号再登录会作废旧 token 并 `kicked` 踢掉旧连接（防止多人共用同一账号）。
  - **发消息/操作必须已登录且是工作区成员**：`send / joinGroup / 翻历史 / 编辑工作区 / 删工作区 / 定时任务 / 拉人` 无身份或非成员分别返回 `{code:"NOT_LOGIN"}` / `{code:"NOT_MEMBER"}`；真人消息写 `senderName=姓名` + `senderAccount=域账号`。
  - **按成员隔离可见性**：socket 只加入自己有权查看的工作区房间；工作区列表 `groups` 事件按登录人过滤推送；工作区/成员变更统一重算所有在线端。判断规则：`memberIds` 含 `human`（开放工作区）或含 `h_<自己的域账号>` 才可见。
  - agent 任务 prompt 的真人称呼动态化：`真人「张三」（域账号 zhangsan1）在工作区里发言`（定时任务触发为「系统触发」）。
- 前端：`apps/web/index.html`
  - 会话凭据存 `localStorage['ah.auth'] = {account, token}`；收到 `kicked` 清凭据并刷新回登录门禁。
  - 侧栏顶部身份条（未登录点此登录 / 已登录显示 姓名·部门 + 退出）。
  - 通讯录「👤 真人同事（N）」全量展示 + 搜索过滤（姓名/域账号/部门）；登录人带「我」标记。
  - 新建工作区/加人弹层内真人区为"关键字搜索勾选"（避免一次渲染数千人）；新建工作区默认**私密**（创建者+勾选真人+AI 可见），勾选「全员真人可见」才成开放工作区；加人只发新增成员（服务端按并集合并，不丢旧成员）。

## 配置（环境变量；不配置 `STAFF_DB_HOST` 即停用该能力）

| 变量 | 默认 | 说明 |
|---|---|---|
| `STAFF_DB_HOST` | 空（= 停用） | 员工库地址 |
| `STAFF_DB_PORT` | `3306` | 端口 |
| `STAFF_DB_USER` | `root` | 账号 |
| `STAFF_DB_PASSWORD` | 空 | 密码 |
| `STAFF_DB_NAME` | `staff` | 库名 |
| `STAFF_DB_TABLE` | `uc_staff` | 员工表名 |

> 这些变量建议写在仓库根目录的 `.env`（参照 `.env.example`，`npm run dev` 会自动加载，**不会入库**）。
> 未配置时通讯录仍可用（只有 AI 成员），不阻塞其它功能。
> 需要独立脚本读取员工数据时，可照抄 `staffDb.ts` 的连接与 SQL 逻辑。

## 多用户部署（跑到服务器上）

每个人用自己的域账号登录，身份与会话隔离如下：

```bash
# 换端口启动（默认 18741）
PORT=18750 node node_modules/tsx/dist/cli.mjs apps/server/src/index.ts
```

- 数据/会话持久化在**当前工作目录**的 `data/`（`groups.json` / `sessions.json` / `messages/` / `uploads/`…）。多实例互相独立，别共用同一 `data`。
- 部署后所有人访问同一地址：每人输入**自己的**域账号登录，浏览器记住 token；同账号在别处再登录会把旧端踢下线。
- 工作区可见性：旧工作区（含 `human`）全员真人可见；**新建工作区默认私密**，勾选「全员真人可见」才全员可见；没被拉入私有工作区的人看不到也收不到。
- 隐私边界提示：当前登录校验只做到"域账号在职 + 单活会话"，**不防冒名**（知道同事域账号即可登录发言）。如公司网关能在请求头注入已登录用户名（SSO），可在此之上加自动取身份，进一步杜绝冒名。
