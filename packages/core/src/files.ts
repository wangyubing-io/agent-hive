import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 工作区文件区：扫描 agent 沙箱目录，diff 出本轮新增/修改的文件。
 * 沙箱即 agent 的 cwd，dsh runtime 的会话状态不落在这里，可安全全量扫描。
 */

export interface FileStamp {
  path: string; // 相对沙箱根的路径，如 "sandbox-check/notes.txt"
  mtimeMs: number;
  size: number;
}

/** 忽略 runtime/依赖噪音目录 */
const EXCLUDE_DIRS = new Set([".dsh", ".git", "node_modules", ".DS_Store", "Thumbs.db"]);
/** 单文件收集上限（50MB），超大的产物让用户自己去沙箱拿 */
export const MAX_COLLECT_BYTES = 50 * 1024 * 1024;

export function scanDir(root: string, prefix = ""): Map<string, FileStamp> {
  const out = new Map<string, FileStamp>();
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e.name) || e.name.startsWith(".dsh")) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      for (const [p, s] of scanDir(root, rel)) out.set(p, s);
    } else if (e.isFile()) {
      try {
        const st = statSync(join(root, rel));
        out.set(rel, { path: rel, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* 文件在扫描瞬间被删，跳过 */
      }
    }
  }
  return out;
}

/** 新增或内容变化的文件（mtime 变了才算，size 相同且 mtime 未变忽略） */
export function diffFiles(before: Map<string, FileStamp>, after: Map<string, FileStamp>): FileStamp[] {
  const changed: FileStamp[] = [];
  for (const [path, st] of after) {
    if (st.size > MAX_COLLECT_BYTES) continue;
    const old = before.get(path);
    if (!old || old.size !== st.size || old.mtimeMs !== st.mtimeMs) changed.push(st);
  }
  return changed;
}

/** 工作区文件条目（落盘 files/<groupId>.json，下载按 id 索引） */
export interface GroupFileEntry {
  id: string;
  groupId: string;
  agentId: string;
  agentName: string;
  agentShortName: string;
  path: string; // 相对收集根的相对路径
  baseDir?: string; // 收集根（绝对路径）：工作区绑定目录或 agent 沙箱根。缺省=沙箱（旧数据兼容）
  name: string; // 文件名（展示用）
  size: number;
  ts: number;
}
