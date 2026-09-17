// 沙箱工具执行层：给 agent 提供真实的文件 / 命令能力。
// 替代原 dsh runtime 的沙箱：所有操作严格限制在 root 目录内，run_shell 带超时与输出截断。
// 纯 Node 依赖（fs / child_process），不 import langchain，保持可单测、可替换。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { resolve, relative, sep, join } from "node:path";
import iconv from "iconv-lite";

const isWin = process.platform === "win32";
const SHELL_TIMEOUT_MS = 60_000;
const SHELL_OUTPUT_MAX = 100_000; // 单次命令 stdout+stderr 上限（字符）

/** 把相对路径解析到 root 内，越界抛错（防 ../ 穿越） */
function withinRoot(root: string, p: string): string {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, p);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`路径越界：${p} 不在工作区内`);
  }
  return abs;
}

/** 读取文件（文本），返回内容；失败抛错（错误信息回给模型，让它自行纠偏）。
 *  编码智能识别：先按严格 UTF-8 校验，非法则按 GBK 解码（Windows 记事本等工具的遗留中文文件）——
 *  保证进入 LLM 上下文的文件内容不带 U+FFFD 乱码。二进制文件前若有合法 UTF-8 前缀会照常返回（与原行为一致）。 */
export function sandboxReadFile(root: string, p: string): string {
  const abs = withinRoot(root, p);
  return decodeOutput(readFileSync(abs));
}

/** 写入文件（自动建父目录），返回确认信息 */
export function sandboxWriteFile(root: string, p: string, content: string): string {
  const abs = withinRoot(root, p);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return `已写入 ${relative(resolve(root), abs) || "."}（${content.length} 字符）`;
}

/** 列出目录内容（路径缺省为工作区根），返回精简条目列表 */
export function sandboxListDir(root: string, p: string): string {
  const abs = withinRoot(root, p);
  const entries = readdirSync(abs, { withFileTypes: true })
    .map((e) => {
      const rel = relative(resolve(root), join(abs, e.name)) || e.name;
      if (e.isDirectory()) return `[dir]  ${rel}`;
      try {
        const sz = statSync(join(abs, e.name)).size;
        return `[file] ${rel} (${sz} B)`;
      } catch {
        return `[file] ${rel}`;
      }
    })
    .sort();
  return entries.length ? entries.join("\n") : `（空目录）`;
}

/** 解码字节内容：先严格校验 UTF-8，非法则按 GBK（中文 Windows 控制台默认代码页 936）解码。
 *  必须在完整 buffer 上做（多字节字符可能跨 chunk 边界切割，逐 chunk 判定会误判）。
 *  修复：此前 toString("utf8") 把 GBK 输出硬解成乱码，既展示给用户也喂给 LLM。
 *  导出供检索层复用（文件内容索引走同一套解码，保证入库内容不带 U+FFFD）。 */
export function decodeOutput(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return iconv.decode(buf, "gbk");
  }
}

/** 执行 shell 命令（cwd=root），返回 stdout+stderr（截断），超时或失败都会带出 exitCode */
export function sandboxRunShell(root: string, command: string, timeoutMs = SHELL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = []; // 累积原始字节，收尾统一解码（避免跨 chunk 的多字节字符被切断误判）
    let totalLen = 0;
    let truncated = false;
    let settled = false;
    const done = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(text);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(decodeOutput(Buffer.concat(chunks)) + `\n[超时 ${timeoutMs}ms，已终止]`);
    }, timeoutMs);

    // Windows 走 cmd，其余走 sh -c。
    // 关键：windowsVerbatimArguments 让命令原文原样传给 cmd —— Node 默认的参数组装会
    // 破坏命令里的引号（node -e "..." 会静默变成"无输出"），verbatim 才能让引号原样到达目标程序。
    // 不带 /s：避免 cmd 把"以引号开头的命令"的首尾引号剥掉（如带空格路径的可执行文件）。
    const child = isWin
      ? spawn("cmd", ["/d", "/c", command], { cwd: root, windowsHide: true, windowsVerbatimArguments: true })
      : spawn("sh", ["-c", command], { cwd: root });

    const append = (d: Buffer) => {
      if (truncated) return;
      chunks.push(d);
      totalLen += d.length;
      if (totalLen > SHELL_OUTPUT_MAX * 4) { // 字节上限（GBK 中文 1 字符≈2 字节，留 4 倍余量，最终按字符截断）
        truncated = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => done(decodeOutput(Buffer.concat(chunks)) + `\n[启动失败] ${err.message}`));
    child.on("close", (code) => {
      let text = decodeOutput(Buffer.concat(chunks));
      if (text.length > SHELL_OUTPUT_MAX) text = text.slice(0, SHELL_OUTPUT_MAX) + "\n[输出截断]";
      else if (truncated) text += "\n[输出截断]";
      const exit = code === 0 ? "" : `\n[exit ${code}]`;
      done((text.trim() || "(无输出)") + exit);
    });
  });
}
