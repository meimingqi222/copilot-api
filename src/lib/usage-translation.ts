/**
 * Shared OpenAI → Anthropic usage translation.
 *
 * OpenAI-shape usage (chat / responses) reports `prompt_tokens` as the TOTAL
 * input size, inclusive of any cached portion. This repo extends that shape
 * with `prompt_tokens_details.cache_creation_input_tokens` (an Anthropic-only
 * concept smuggled through the OpenAI usage shape) which, like
 * `cached_tokens`, is a subset of `prompt_tokens` — not additional to it.
 *
 * Anthropic-shape usage instead reports `input_tokens` as a NET value that
 * excludes both `cache_read_input_tokens` and `cache_creation_input_tokens`,
 * which are reported separately. Converting between the two shapes therefore
 * requires subtracting BOTH cache buckets from `prompt_tokens`, not just the
 * cache-read one — see docs/refactor-usage-translation.md for the full
 * background and the conservation invariant this preserves.
 */

interface OpenAIUsageLike {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export interface AnthropicUsageLike {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** OpenAI 形状 usage → Anthropic 形状 usage（净值语义）。 */
export function openAIUsageToAnthropic(
  usage: OpenAIUsageLike,
): AnthropicUsageLike {
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheCreationTokens =
    usage.prompt_tokens_details?.cache_creation_input_tokens

  return {
    input_tokens: Math.max(
      0,
      usage.prompt_tokens - cachedTokens - (cacheCreationTokens ?? 0),
    ),
    output_tokens: usage.completion_tokens,
    ...(cachedTokens !== 0 && { cache_read_input_tokens: cachedTokens }),
    ...(cacheCreationTokens !== undefined && {
      cache_creation_input_tokens: cacheCreationTokens,
    }),
  }
}

/**
 * Anthropic 形状 usage → OpenAI 形状 usage（净值语义的严格反向）。
 * `openAIUsageToAnthropic` 把 cache buckets 从 prompt_tokens 中扣除得到
 * 净值 input_tokens；此函数把净值 + 两个 cache buckets 加回 prompt_tokens，
 * 保持守恒不变量（refactor-usage-translation.md）。
 *
 * 供 chat→messages 响应翻译使用（OpenAI 形状响应必须报告总量）。
 */
export function anthropicUsageToOpenAI(
  usage: AnthropicUsageLike,
): OpenAIUsageLike {
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheCreationTokens = usage.cache_creation_input_tokens

  const details:
    | { cached_tokens?: number; cache_creation_input_tokens?: number }
    | undefined =
    cacheReadTokens !== 0 || cacheCreationTokens !== undefined ?
      {
        ...(cacheReadTokens !== 0 && { cached_tokens: cacheReadTokens }),
        ...(cacheCreationTokens !== undefined && {
          cache_creation_input_tokens: cacheCreationTokens,
        }),
      }
    : undefined

  return {
    prompt_tokens:
      usage.input_tokens + cacheReadTokens + (cacheCreationTokens ?? 0),
    completion_tokens: usage.output_tokens,
    ...(details !== undefined && { prompt_tokens_details: details }),
  }
}
