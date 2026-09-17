import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, appendFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

let seq = 0;
export function newId(prefix = "id"): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 文件存储引擎：所有数据落磁盘文件，接口按“以后可换数据库”的仓库风格设计。
 * - settings.json / agents.json / groups.json  整文件 JSON
 * - messages/<groupId>.jsonl                    消息 append-only 追加
 */
export class FileStore {
  constructor(public root: string) {
    mkdirSync(join(root, "messages"), { recursive: true });
    mkdirSync(join(root, "files"), { recursive: true });
    mkdirSync(join(root, "sandbox"), { recursive: true });
  }

  private path(...p: string[]) {
    return join(this.root, ...p);
  }

  readJson<T>(file: string, fallback: T): T {
    const p = this.path(file);
    if (!existsSync(p)) return fallback;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(file: string, data: unknown): void {
    const p = this.path(file);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, p);
  }

  appendLine(file: string, line: unknown): void {
    const p = this.path(file);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(line) + "\n", "utf8");
  }

  readLines<T>(file: string): T[] {
    const p = this.path(file);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as T;
        } catch {
          return null;
        }
      })
      .filter((x): x is T => x !== null);
  }

  /** 只读文件末尾最多 n 行（按字节从后向前扫，避免整文件读入内存）。
   *  适用于「工作区列表摘要取最后一条」「进入工作区取最近一页」等热路径。
   *  注意：假设每行是单条 JSON（JSON.stringify 会把换行转义成字面 \n，不会出现物理换行）。 */
  readLinesTail<T>(file: string, n: number): T[] {
    if (n <= 0) return [];
    const p = this.path(file);
    if (!existsSync(p)) return [];
    const size = statSync(p).size;
    if (size === 0) return [];
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let pos = size;
    let tail = ""; // 已读文本的最前一段（可能跨 chunk 未闭合），下一轮拼到更早内容后面
    const out: string[] = [];
    while (pos > 0 && out.length < n) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const fd = openSync(p, "r");
      let rd = 0;
      try {
        rd = readSync(fd, buf, 0, len, pos);
      } finally {
        closeSync(fd);
      }
      const combined = buf.toString("utf8", 0, rd) + tail;
      const lines = combined.split("\n");
      tail = lines.shift() || ""; // 首段跨 chunk 边界，留待更早内容拼接
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        if (lines[i].length === 0) continue; // 跳过尾部空行
        out.unshift(lines[i]);
      }
    }
    if (out.length < n && tail.length > 0) out.unshift(tail); // 文件首行
    return out
      .map((l) => {
        try {
          return JSON.parse(l) as T;
        } catch {
          return null;
        }
      })
      .filter((x): x is T => x !== null);
  }

  filePath(rel: string): string {
    return this.path(rel);
  }
}
