// 检索层真实数据验证：群聊索引/检索 + 文件索引/检索 + 幂等 + 短查询兜底
import { getRetrieval, formatChatHits, formatFileHits } from "../packages/core/src/retrieval.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = join(process.cwd(), "data");
const r = getRetrieval(DATA);

// 1) 群聊全量索引（真实 g-dev 历史）
const lines = readFileSync(join(DATA, "messages", "g-dev.jsonl"), "utf8").trim().split("\n");
const msgs = lines.map((l) => JSON.parse(l));
const n1 = r.indexChat("g-dev", msgs);
const n2 = r.indexChat("g-dev", msgs); // 幂等：应 0
console.log(`[chat] 首次索引 ${n1} 条（总 ${msgs.length} 条），重复索引 ${n2} 条（应 0）`);

// 2) 中文关键词检索（trigram MATCH 路径，真实数据关键词）
const q1 = process.argv[2] || "自我介绍";
console.log(`\n[chat] 检索「${q1}」：`);
console.log(formatChatHits(r.searchChat("g-dev", q1)));

// 3) <3 字符短查询（LIKE 兜底路径）
const q2 = process.argv[3] || "算术";
console.log(`\n[chat] 查询「${q2}」：`);
console.log(formatChatHits(r.searchChat("g-dev", q2)).slice(0, 400));

// 4) 文件索引（真实沙箱目录）
const res = r.indexDir("g-dev", "ai-qa", join(DATA, "sandbox", "ai-qa"));
console.log(`\n[file] ai-qa 沙箱扫描 ${res.scanned} 文件，新索引 ${res.indexed} 个`);
const res2 = r.indexDir("g-dev", "ai-qa", join(DATA, "sandbox", "ai-qa"));
console.log(`[file] 重复扫描新索引 ${res2.indexed} 个（应 0，file_state 跳过未变文件）`);

// 5) 文件内容检索（用一个沙箱文件里真实存在的词）
const q3 = process.argv[4] || "server";
console.log(`\n[file] 检索「${q3}」：`);
console.log(formatFileHits(r.searchFiles("g-dev", q3)));

console.log("\n[stats]", JSON.stringify(r.stats()));

// 6) 进程退出后重开验证（WAL 落盘正确性）
r.close();
const r2 = getRetrieval(DATA);
console.log("[reopen] 重开实例 stats:", JSON.stringify(r2.stats()), "（应与上面一致）");
const hit = r2.searchChat("g-dev", q1);
console.log(`[reopen] 重开后检索「${q1}」命中 ${hit.length} 条（应 > 0）`);
r2.close();
