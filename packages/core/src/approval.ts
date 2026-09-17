// 危险命令识别 + 人工审批闸门（配合 llm.ts 的 run_shell 工具内 interrupt() 使用）。
// 设计目标：把「提示词层面的软约束」升级为「图级别的硬停」。
//   - agent-hive 的沙箱只约束了文件类工具（read_file/write_file/list_dir 走 withinRoot），
//     run_shell 直接把命令交给宿主机 shell —— 既有隐患是 agent 能 `cat ../../settings.json`
//     读到 LLM Token / 搜索 Key，也能 `git push` 自行推代码。
//   - 本模块只做「识别」这一件纯函数的事（零依赖、可离线单测）；
//     真正的挂起/恢复由 @langchain/langgraph 的 interrupt()/Command({resume}) 完成。
export interface DangerRule {
  id: string;
  label: string;
  re: RegExp;
}

/** 命中结果：id/label 供 UI 显示，sample 是命中的原文片段（供审批人核对） */
export interface DangerMatch {
  id: string;
  label: string;
  sample: string;
}

/** 等待人工审批的默认超时（ms）：超时视为拒绝，避免无人值守时任务永久挂起 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

/**
 * 内置危险命令规则。取舍原则：
 *   - 只拦「不可逆 / 越权 / 泄密」三类，不拦日常开发（curl 抓网页、npm install、git commit 等一律放行）；
 *   - 宁可漏拦也不滥拦——滥拦会让 agent 频繁停下等人，反而逼真人关掉整个闸门。
 */
const DEFAULT_RULES: DangerRule[] = [
  { id: "path-escape", label: "访问工作区外的路径（../ 越界）", re: /(^|[\s'"=<>|;&(])\.\.[/\\]|(^|[\s;&|])(?:cd|pushd)\s+\.\.[\s;&|]*$/ },
  { id: "rm-recursive", label: "递归/强制删除（rm -rf 等）", re: /\brm\b[^\n]*\s(?:-[A-Za-z]*r[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*|--recursive|--force)\b/ },
  { id: "rm-windows", label: "Windows 批量删除（del /s、rd /s 等）", re: /\b(?:del|rd|rmdir|erase)\b[^\n]*\/[a-z]*[sq][a-z]*\b/i },
  { id: "git-push", label: "推送代码到远端（git push）", re: /\bgit\s+push\b/ },
  { id: "git-destructive", label: "破坏性 git 操作（reset --hard / clean -f / branch -D）", re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s)/ },
  { id: "privilege", label: "提权执行（sudo / doas / su）", re: /(^|[\s;&|])(?:sudo|doas|su)\s/ },
  { id: "system-write", label: "写入系统目录", re: />{1,2}\s*(?:\/(?:etc|usr|bin|sbin|boot|var|opt|System)\b|[A-Za-z]:\\Windows)/i },
  { id: "pipe-remote-sh", label: "管道执行远程脚本（curl|sh）", re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|d)?sh\b/ },
  { id: "credential-read", label: "读取凭据/密钥文件", re: /\b(?:cat|type|less|more|head|tail|xxd|od|base64|cp|scp|grep|sed|awk|Get-Content|Select-String)\b[^\n]*(?:settings\.json|git-creds\.json|\.creds[/\\]|id_rsa|id_ed25519|\.npmrc|\.git-credentials|\.ssh[/\\]|\.aws[/\\])/i },
  { id: "api-key-env", label: "打印密钥类环境变量", re: /\b(?:printenv|env|echo|export|Get-ChildItem)\b[^\n]*\b(?:DEEPSEEK|ANTHROPIC|OPENAI|BOCHA|TAVILY|GIT)_?(?:API_)?KEY\b/i },
  { id: "disk-device", label: "磁盘/设备级破坏（mkfs / dd if= / 写块设备）", re: /\b(?:mkfs|fdisk|parted)\b|\bdd\s+if=|\/dev\/(?:sd|nvme|disk|hd)[a-z0-9]*/ },
  { id: "publish", label: "发布制品到公共仓库（npm publish 等）", re: /\b(?:npm|pnpm|yarn)\s+publish\b/ },
  { id: "docker-destructive", label: "删除容器/镜像/数据卷", re: /\bdocker\s+(?:rm|rmi|volume\s+rm|system\s+prune)\b/ },
];

/**
 * 编译用户追加的危险命令正则（配置项 extraPatterns）。
 * 单条正则非法只忽略该条，不影响其余规则——避免一条写错就让整个闸门失效。
 * --- @ty.aicoding@1789442083508 ---
 */
export function compileExtraRules(patterns?: string[]): DangerRule[] {
  if (!Array.isArray(patterns)) return [];
  const out: DangerRule[] = [];
  for (const p of patterns) {
    const src = typeof p === "string" ? p.trim() : "";
    if (!src) continue;
    try {
      out.push({ id: `custom:${src.slice(0, 40)}`, label: `自定义规则：${src.slice(0, 60)}`, re: new RegExp(src, "i") });
    } catch {
      /* 非法正则忽略 */
    }
  }
  return out;
}

/** 全部生效规则（内置 + 用户追加） */
export function dangerRules(extraPatterns?: string[]): DangerRule[] {
  return [...DEFAULT_RULES, ...compileExtraRules(extraPatterns)];
}

/**
 * 识别一条 shell 命令是否命中危险模式。
 * 命中返回首个匹配（内置规则优先，顺序固定 → 结果可预期），未命中返回 null。
 * --- @ty.aicoding@1789442083508 ---
 */
export function detectDangerousCommand(command: string, extraPatterns?: string[]): DangerMatch | null {
  const cmd = typeof command === "string" ? command : "";
  if (!cmd.trim()) return null;
  for (const rule of dangerRules(extraPatterns)) {
    const m = rule.re.exec(cmd);
    if (!m) continue;
    // 命中片段两侧截断：命令可能很长（>1k），只带关键片段给审批人看
    const idx = Math.max(0, m.index - 20);
    const sample = cmd.slice(idx, Math.min(cmd.length, idx + 160)).replace(/\s+/g, " ").trim();
    return { id: rule.id, label: rule.label, sample };
  }
  return null;
}
