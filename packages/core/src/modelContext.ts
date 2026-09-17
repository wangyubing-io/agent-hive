/**
 * 模型上下文窗口识别：按模型名子串匹配常见模型家族的官方上下文长度。
 * 识别不到 → null（由调用方决定默认值）。
 *
 * 原则：宁可猜小（窗口小于模型能力只是浪费，不会出错），不可猜大（超模型窗口会直接报错截断）。
 * 用户在设置页可手动覆盖（LlmConfig.contextTokens），以手动值为准。
 */

/** 未识别模型时的默认窗口（按用户环境约定：所用模型最少 256k） */
export const DEFAULT_CONTEXT_TOKENS = 256_000;

/** 常见模型家族 → 上下文窗口（tokens）。按顺序子串匹配，先命中先用 */
const MODEL_CONTEXT_TABLE: Array<[RegExp, number]> = [
  // Anthropic
  [/claude/, 200_000],
  // OpenAI
  [/gpt-5|gpt-4\.?1/, 1_000_000],
  [/gpt-4o|chatgpt/, 128_000],
  [/\bo3\b|\bo4\b/, 200_000],
  // Google
  [/gemini/, 1_000_000],
  // DeepSeek（V3/R1 系列官方 128k；v4 未证实前保守取 128k，可在设置页覆盖）
  [/deepseek/, 128_000],
  // 阿里
  [/qwen-?3|qwen-?max|qwen-?plus|qwen-?long/, 1_000_000],
  [/qwen/, 131_072],
  // 智谱 / 月之暗面 / 字节 / 腾讯 / MiniMax / xAI
  [/glm/, 200_000],
  [/kimi|moonshot/, 256_000],
  [/doubao/, 256_000],
  [/hunyuan/, 256_000],
  [/minimax/, 1_000_000],
  [/grok/, 1_000_000],
  // 开源系
  [/llama/, 128_000],
  [/mistral|mixtral/, 128_000],
  [/ernie/, 128_000],
];

/** 按模型名识别上下文窗口；识别不到返回 null */
export function guessContextTokens(model: string): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [re, tokens] of MODEL_CONTEXT_TABLE) {
    if (re.test(m)) return tokens;
  }
  return null;
}
