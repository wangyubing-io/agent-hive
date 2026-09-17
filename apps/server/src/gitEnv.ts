// git 环境自举 + 工作区 Git 能力（克隆/拉取已有 cloneGroupRepo 流程在 index.ts，本模块管：
// 1) 启动异步自检 git，缺失时按平台后台安装（容器 alpine→apk、debian→apt、win→winget、mac→指引）；
// 2) 各登录人自己的推送凭据（data/git-creds.json，0600，key=域账号）；
// 3) 仓库状态快照 + 提交并推送（含凭据注入与人性化错误）。
// 纯 Node 依赖（fs/child_process/node:url），不 import langchain，可独立测试。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";

export type GitEnvStatus = "checking" | "ready" | "installing" | "missing";
export interface GitEnvState {
  status: GitEnvStatus;
  version?: string; // 如 "2.45.1"
  detail?: string; // missing/installing 原因或安装说明
}

// ---------- 1) 环境自举 ----------
let envState: GitEnvState = { status: "checking" };
let envPromise: Promise<GitEnvState> | null = null;
const envListeners = new Set<(s: GitEnvState) => void>();

/** 订阅 git 环境状态变化（就绪/安装结束/失败时回调） */
export function onGitEnvChange(cb: (s: GitEnvState) => void): () => void {
  envListeners.add(cb);
  return () => envListeners.delete(cb);
}
function publish(s: GitEnvState) {
  envState = s;
  for (const cb of envListeners) {
    try { cb(s); } catch { /* 监听器异常不影响 */ }
  }
}
export function gitEnvState(): GitEnvState {
  return envState;
}

/** Windows 常见安装路径（winget 装完本进程 PATH 不刷新，需按绝对路径找 git） */
function knownGitPath(): string {
  if (process.platform !== "win32") return "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  for (const p of [join(pf, "Git", "cmd", "git.exe"), join(pf86, "Git", "cmd", "git.exe"), join(pf, "Git", "bin", "git.exe")]) {
    if (existsSync(p)) return p;
  }
  return "";
}
/** 实际执行 git 的程序：优先绝对路径（win 安装后 PATH 不刷新），否则裸 git 走 PATH */
export function gitBin(): string {
  return knownGitPath() || "git";
}

/** 运行命令，收 stdout/stderr 与退出码（不抛，ENOENT 也走 error 返回） */
function exec(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs || 300_000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e.message || e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}
export interface GitRunResult { code: number; out: string; err: string }
export function runGit(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<GitRunResult> {
  return exec(gitBin(), args, opts);
}
/** git 报错取可读的最后几行（stderr 常为多行堆栈） */
export function gitErrOf(r: { out: string; err: string }): string {
  const lines = (r.err || r.out || "").trim().split(/\r?\n/).filter(Boolean);
  return (lines.slice(-3).join(" ") || "未知错误").slice(0, 400);
}

async function probe(): Promise<GitEnvState> {
  const r = await runGit(["--version"], { timeoutMs: 15_000 });
  const m = /^git version\s+(\S+)/i.exec((r.out || "").trim());
  if (r.code === 0 && m) return { status: "ready", version: m[1] };
  const e = (r.err || r.out || "").trim();
  return { status: "missing", detail: /ENOENT|not (found|recognized)/i.test(e) ? "git 未安装" : e.slice(0, 200) || "git 不可用" };
}

function isRoot(): boolean {
  try {
    return typeof process.getuid === "function" ? process.getuid() === 0 : true;
  } catch {
    return true;
  }
}
async function runWithSudo(args: string[]): Promise<GitRunResult> {
  const root = isRoot();
  if (root) return exec(args[0], args.slice(1), { timeoutMs: 600_000 });
  // 非 root：尝试 sudo -n（无交互）
  const sudoOk = await exec("sudo", ["-n", "--version"], { timeoutMs: 8000 });
  if (sudoOk.code === 0) return exec("sudo", ["-n", ...args], { timeoutMs: 600_000 });
  return { code: -1, out: "", err: "非 root 且无 sudo 权限，无法自动安装 git" };
}

/** 按平台后台安装 git（失败不抛：返回 false + 说明，状态置 missing 给出指引） */
async function installGit(): Promise<void> {
  const p = process.platform;
  try {
    if (p === "win32") {
      const w = await exec("winget", ["install", "--id", "Git.Git", "-e", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements"], { timeoutMs: 600_000 });
      if (w.code !== 0) {
        publish({ status: "missing", version: envState.version, detail: `自动安装 git 失败：${gitErrOf(w)}（可手动安装 https://git-scm.com/download/win 后重启服务）` });
      }
      return; // 成败都交给 probe 复检；winget 装了 PATH 不刷新 → probe 靠 knownGitPath 命中
    }
    if (p === "darwin") {
      // mac 常见已带 git（xcode CLT）；没有则无法无交互安装，给指引
      publish({ status: "missing", version: envState.version, detail: "macOS 未检测到 git：请执行 `xcode-select --install` 或 `brew install git` 后重启服务" });
      return;
    }
    if (p !== "linux") {
      publish({ status: "missing", version: envState.version, detail: `暂不支持在 ${p} 上自动安装 git，请手动安装后重启服务` });
      return;
    }
    let r: GitRunResult;
    if (existsSync("/etc/alpine-release") || existsSync("/sbin/apk") || existsSync("/usr/bin/apk")) {
      r = await runWithSudo(["apk", "add", "--no-cache", "git"]);
    } else if (existsSync("/usr/bin/apt-get") || existsSync("/usr/bin/apt")) {
      r = await runWithSudo(["sh", "-c", "apt-get update -qq && apt-get install -y -qq --no-install-recommends git"]);
    } else if (existsSync("/usr/bin/dnf")) {
      r = await runWithSudo(["dnf", "install", "-y", "git"]);
    } else if (existsSync("/usr/bin/yum")) {
      r = await runWithSudo(["yum", "install", "-y", "git"]);
    } else {
      publish({ status: "missing", version: envState.version, detail: "无法识别的 Linux 发行版，请手动安装 git 后重启服务" });
      return;
    }
    if (r.code !== 0) {
      publish({ status: "missing", version: envState.version, detail: `自动安装 git 失败：${gitErrOf(r)}（请手动安装 git 后重启服务）` });
    }
  } catch (e) {
    publish({ status: "missing", version: envState.version, detail: `自动安装 git 异常：${(e as Error).message}` });
  }
}

/** 启动自举：异步探测 →（缺失）后台安装 → 复检，最终把状态 publish 出去。幂等（并发调用只跑一次）。 */
export function ensureGitEnv(): Promise<GitEnvState> {
  if (envPromise) return envPromise;
  envPromise = (async () => {
    publish({ status: "checking" });
    let st = await probe();
    if (st.status === "missing") {
      publish({ status: "installing", version: st.version, detail: "检测到 git 缺失，正在后台自动安装…（不影响服务启动）" });
      await installGit();
      st = await probe();
      if (st.status === "missing") st.detail = st.detail || "git 安装后仍不可用，请手动安装并重启服务";
    }
    publish(st);
    return st;
  })();
  return envPromise;
}

// ---------- 2) 登录人推送凭据（data/git-creds.json）----------
export interface GitCred {
  username: string; // http 用户名（GitLab 常为域账号/oauth2；纯 token 推送时可为任意非空）
  password: string; // 密码 或 访问令牌
  ts: number;
}
type CredMap = Record<string, GitCred>;
function credFile(dataDir: string): string {
  return join(dataDir, "git-creds.json");
}
function loadCreds(dataDir: string): CredMap {
  try {
    const raw = readFileSync(credFile(dataDir), "utf8");
    const o = JSON.parse(raw) as CredMap;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function saveCreds(dataDir: string, map: CredMap) {
  try {
    mkdirSync(dataDir, { recursive: true });
    const f = credFile(dataDir);
    writeFileSync(f, JSON.stringify(map, null, 2), "utf8");
    try { chmodSync(f, 0o600); } catch { /* Windows 无 chmod 语义 */ }
  } catch (e) {
    throw new Error(`保存 git 凭据失败: ${(e as Error).message}`);
  }
}
export function gitCredOf(dataDir: string, account: string): GitCred | undefined {
  return loadCreds(dataDir)[account];
}
/** 解析 git 仓库 URL 中内嵌的账号凭据（https://user:pass@host/…），无内嵌返回 undefined */
export function embeddedCredOf(url: string): GitCred | undefined {
  try {
    const u = new URL(url);
    if (!u.username) return undefined;
    return {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password || ""),
      ts: Date.now(),
    };
  } catch {
    return undefined;
  }
}
/** 保存/更新当前登录人的 git 凭据（仅内存+落盘，不回传 UI） */
export function saveGitCred(dataDir: string, account: string, cred: { username: string; password: string }): { username: string; ts: number } {
  const map = loadCreds(dataDir);
  map[account] = { username: cred.username.trim(), password: cred.password, ts: Date.now() };
  saveCreds(dataDir, map);
  return { username: map[account].username, ts: map[account].ts };
}
export function clearGitCred(dataDir: string, account: string): boolean {
  const map = loadCreds(dataDir);
  if (!map[account]) return false;
  delete map[account];
  saveCreds(dataDir, map);
  return true;
}
/** 给仓库地址注入账号凭据（URL 已内嵌账号则不覆盖，交给原样处理） */
export function authUrlOf(url: string, cred?: GitCred): string {
  if (!cred || !cred.username || !cred.password) return url;
  try {
    const u = new URL(url);
    if (u.username || u.password) return url; // 已内嵌凭据：保持原样（可能为临时注入）
    u.username = encodeURIComponent(cred.username);
    u.password = encodeURIComponent(cred.password);
    return u.toString();
  } catch {
    return url;
  }
}

// ---------- 3) 仓库状态 & 提交推送 ----------
export interface RepoInfo {
  isRepo: boolean;
  branch?: string; // 当前分支，如 main
  head?: string; // 短 rev
  changes: number; // 工作区未提交改动文件数
  host?: string; // 远端主机（取 origin URL，脱敏仅 host[:port]）
  error?: string;
}
/** 快速仓库快照：是否 git 仓库 + 分支 + 短 rev + 未提交改动数（用于工具条展示） */
export async function repoInfo(dir: string): Promise<RepoInfo> {
  const base: RepoInfo = { isRepo: false, changes: 0 };
  if (!dir || !existsSync(dir)) return { ...base, error: "目录不存在" };
  const ok = await runGit(["-C", dir, "rev-parse", "--is-inside-work-tree"], { timeoutMs: 15_000 });
  if (ok.code !== 0 || ok.out.trim() !== "true") return { ...base, error: "不是 git 仓库（可在下方克隆或 git init）" };
  const [branch, head, dirty, origin] = await Promise.all([
    runGit(["-C", dir, "symbolic-ref", "--short", "HEAD"], { timeoutMs: 10_000 }),
    runGit(["-C", dir, "rev-parse", "--short", "HEAD"], { timeoutMs: 10_000 }),
    runGit(["-C", dir, "status", "--porcelain"], { timeoutMs: 15_000 }),
    runGit(["-C", dir, "remote", "get-url", "origin"], { timeoutMs: 10_000 }),
  ]);
  const info: RepoInfo = {
    isRepo: true,
    branch: branch.code === 0 && branch.out.trim() ? branch.out.trim() : undefined,
    head: head.code === 0 && head.out.trim() ? head.out.trim() : undefined,
    changes: dirty.code === 0 && dirty.out.trim() ? dirty.out.trim().split(/\r?\n/).filter(Boolean).length : 0,
  };
  if (origin.code === 0 && origin.out.trim()) {
    try { info.host = new URL(origin.out.trim()).host; } catch { info.host = origin.out.trim().slice(0, 120); }
  }
  return info;
}

export interface PushResult {
  ok: boolean;
  changed: number; // 本轮 add -A 后待提交文件数
  committed?: boolean; // 是否有新提交
  pushed?: boolean;
  branch?: string;
  head?: string;
  message: string; // 成功摘要或错误提示
}
const BOT_COMMITTER = { name: "agent-hive bot", email: "agent-hive@localhost" };
/** 提交并推送：add -A → commit（显式身份，不依赖全局 user.name/email）→ push。
 *  push 目标：传了 authUrl 则直推该地址（凭据动态注入、不留 .git/config）；否则推 origin（本机 credential helper）。 */
export async function commitAndPush(opts: {
  dir: string;
  message?: string;
  committer?: { name: string; email: string };
  authUrl?: string; // 推送地址（可含临时凭据）；缺省推 origin
  timeoutMs?: number;
}): Promise<PushResult> {
  const { dir, message, committer = BOT_COMMITTER, authUrl } = opts;
  const fail = (msg: string, extra?: string): PushResult => ({ ok: false, changed: 0, message: extra ? `${msg}：${extra}` : msg });
  if (!dir || !existsSync(dir)) return fail("工作目录不存在，无法提交", dir);
  const add = await runGit(["-C", dir, "add", "-A"], { cwd: dir, timeoutMs: 120_000 });
  if (add.code !== 0) return fail("git add 失败", gitErrOf(add));
  const st = await runGit(["-C", dir, "status", "--porcelain"], { cwd: dir, timeoutMs: 30_000 });
  const lines = st.code === 0 && st.out.trim() ? st.out.trim().split(/\r?\n/).filter(Boolean) : [];
  if (st.code !== 0) return fail("git status 失败", gitErrOf(st));
  if (lines.length === 0) return { ok: true, changed: 0, message: "工作区无改动，无需提交" };

  const branchR = await runGit(["-C", dir, "symbolic-ref", "--short", "HEAD"], { cwd: dir, timeoutMs: 10_000 });
  const branch = branchR.code === 0 && branchR.out.trim() ? branchR.out.trim() : "HEAD";
  const cleanMsg = (message || "").trim() || `[agent-hive] 工作区自动提交 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
  const commit = await runGit(
    ["-C", dir, "-c", `user.name=${committer.name}`, "-c", `user.email=${committer.email}`, "commit", "-m", cleanMsg],
    { cwd: dir, timeoutMs: 60_000 }
  );
  if (commit.code !== 0) return fail("git commit 失败", gitErrOf(commit));
  // 推送：有 authUrl（含脱敏地址或注入凭据的地址）→ 直推；否则 origin
  const hasOrigin = authUrl || (await runGit(["-C", dir, "remote", "get-url", "origin"], { cwd: dir, timeoutMs: 10_000 })).code === 0;
  if (!hasOrigin) return { ok: true, changed: lines.length, committed: true, pushed: false, branch, message: `已本地提交（无远端，未推送）：${cleanMsg}` };
  const pushArgs = authUrl
    ? ["-C", dir, "push", authUrl, `HEAD:refs/heads/${branch}`]
    : ["-C", dir, "push", "origin", `HEAD:refs/heads/${branch}`];
  const push = await runGit(pushArgs, { cwd: dir, timeoutMs: opts.timeoutMs || 300_000 });
  if (push.code !== 0) {
    const err = gitErrOf(push);
    const hint = /authentication|401|403|authorization|incorrect|could not read Username/i.test(err)
      ? "远端认证失败：请在本工作区输入框上方的 Git 条「凭据」里保存正确的用户名与访问令牌/密码"
      : /rejected|fetch first|non-fast-forward|behind/i.test(err)
        ? "远端有新提交：请先「拉取更新」（克隆按钮会先 pull）再推送"
        : "请检查网络与远端地址";
    return { ok: false, changed: lines.length, committed: true, branch, message: `已本地提交但推送失败（${hint}）：${err}` };
  }
  const headR = await runGit(["-C", dir, "rev-parse", "--short", "HEAD"], { cwd: dir, timeoutMs: 10_000 });
  return {
    ok: true, changed: lines.length, committed: true, pushed: true,
    branch, head: headR.code === 0 && headR.out.trim() ? headR.out.trim() : undefined,
    message: `✅ 已提交并推送 ${lines.length} 个文件 → ${branch}${headR.code === 0 && headR.out.trim() ? "@" + headR.out.trim() : ""}`,
  };
}

// ---------- 4) 仓库级推送凭据（agent 用 run_shell 直接 push 的认证通道）----------
// 设计：克隆成功后（或登录人保存凭据时），把该真人凭据写进仓库专属 credential-store 文件
// （git config credential.helper = store --file=<仓库/.git/agent-credentials>，0600）。
// - .git/config 的 origin 仍保持脱敏地址：token 不落 config，read_file 读 config 也看不到；
// - agent 在工作区里 run_shell 直接 git push 时，git 自动经 helper 完成认证，无需任何服务端代劳；
// - 凭据与保存它的登录人绑定，再次保存即覆盖（可更改），清除时同步移除。
export interface RepoAuthSetup {
  configured: boolean; // 是否写入了凭据（false = 无凭据可写，仅配提交身份）
  summary: string;
}
/** 为该仓库写入推送凭据 + 默认提交身份（仓库 local，不影响全局配置）。
 *  credFile 缺省 <dir>/.git/agent-credentials；传 data 目录下独立文件可避免 token 落在工作区。 */
export async function setupRepoAuth(opts: {
  dir: string; // 仓库根（须为 git 仓库）
  url?: string; // 脱敏 origin（取 host 拼 credential 行）
  username?: string;
  password?: string;
  commitName?: string;
  commitEmail?: string;
  credFile?: string;
}): Promise<RepoAuthSetup> {
  const { dir, url, username, password, commitName, commitEmail } = opts;
  if (!dir || !existsSync(join(dir, ".git", "config"))) {
    throw new Error(`不是 git 仓库，无法配置推送凭据: ${dir}`);
  }
  const credFile = opts.credFile || join(dir, ".git", "agent-credentials");
  const msgs: string[] = [];
  if (username && password) {
    let line = "";
    try {
      const host = new URL(url || "").host;
      if (host) line = `https://${username}:${password}@${host}/`;
    } catch { /* 无合法 host 不写凭据 */ }
    if (line) {
      try {
        mkdirSync(join(credFile, ".."), { recursive: true });
        writeFileSync(credFile, line + "\n", "utf8");
        try { chmodSync(credFile, 0o600); } catch { /* Windows 无 chmod 语义 */ }
      } catch (e) {
        throw new Error(`写推送凭据文件失败: ${(e as Error).message}`);
      }
      const set = await runGit(["-C", dir, "config", "credential.helper", `store --file=${credFile}`], { timeoutMs: 15_000 });
      if (set.code !== 0) throw new Error("git 配置 credential.helper 失败: " + gitErrOf(set));
      msgs.push("推送凭据已配置（仓库级）");
    }
  }
  // 默认提交身份：缺省给 bot；传入真人则署名真人（agent 代真人 commit 时仓库 local 身份生效）
  const name = (commitName || "agent-hive bot").slice(0, 100);
  const email = (commitEmail || "agent-hive@localhost").slice(0, 200);
  const [n, e] = await Promise.all([
    runGit(["-C", dir, "config", "user.name", name], { timeoutMs: 15_000 }),
    runGit(["-C", dir, "config", "user.email", email], { timeoutMs: 15_000 }),
  ]);
  if (n.code !== 0 || e.code !== 0) msgs.push("提交身份配置失败（可后续手动设置）");
  return { configured: msgs.length > 0, summary: msgs.join("；") || "已配置默认提交身份" };
}
/** 移除该仓库的 credential.helper 配置并删除凭据文件（真人清除凭据时同步调用，防"清了还能推"） */
export async function clearRepoAuth(opts: { dir: string; credFile?: string }): Promise<void> {
  const { dir } = opts;
  const credFile = opts.credFile || join(dir, ".git", "agent-credentials");
  await runGit(["-C", dir, "config", "--unset-all", "credential.helper"], { timeoutMs: 15_000 }).catch(() => {});
  try { unlinkSync(credFile); } catch { /* 不存在也正常 */ }
}
