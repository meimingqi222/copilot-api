import type { Context } from "hono"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamingUsage,
} from "~/services/protocols/anthropic"

import { logger } from "~/lib/logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage } from "~/lib/usage"
import { translateToOpenAI } from "~/services/protocols/anthropic"

export interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export function recordStreamingUsage(
  c: Context,
  accountId: string,
  lastUsage: UsageInfo | undefined,
  timing?: { ttftMs: number; tps: number },
  estimatedInputTokens = 0,
): void {
  const model = c.get("model")
  if (!model) {
    return
  }

  // 上游流里没有任何 usage chunk:用本地估算记一行,否则这次请求完全不可见。
  if (!lastUsage) {
    if (estimatedInputTokens <= 0) return
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: estimatedInputTokens,
      completionTokens: 0,
      totalTokens: estimatedInputTokens,
      tps: 0,
      ttftMs: timing?.ttftMs,
      streaming: true,
      finishReason: "usage_missing",
    })
    return
  }

  const cacheReadTokens = lastUsage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens =
    lastUsage.prompt_tokens_details?.cache_creation_input_tokens ?? 0
  recordUsage({
    c,
    accountId,
    model,
    // prompt_tokens 是总量(含缓存读与缓存写,见 usage-translation.ts),
    // 两者都要扣除,仅扣缓存读会把缓存写 double-bill(一次按 prompt 价,
    // 一次按 cache-write 价)。与 chat 非流式/流式路径保持一致。
    promptTokens: Math.max(
      lastUsage.prompt_tokens - cacheReadTokens - cacheWriteTokens,
      0,
    ),
    completionTokens: lastUsage.completion_tokens,
    totalTokens: lastUsage.total_tokens,
    cacheReadTokens,
    cacheWriteTokens,
    ttftMs: timing?.ttftMs,
    tps: timing?.tps,
    streaming: true,
  })
}

export function recordDirectStreamingUsage(
  c: Context,
  accountId: string,
  lastUsage: AnthropicStreamingUsage | undefined,
  timing?: { ttftMs: number; tps: number },
  estimatedInputTokens = 0,
): void {
  const model = c.get("model")
  if (!model) {
    return
  }

  if (!lastUsage) {
    if (estimatedInputTokens <= 0) return
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: estimatedInputTokens,
      completionTokens: 0,
      totalTokens: estimatedInputTokens,
      tps: 0,
      ttftMs: timing?.ttftMs,
      streaming: true,
      finishReason: "usage_missing",
    })
    return
  }

  // Anthropic API: input_tokens does NOT include cache tokens
  const cacheReadTokens = lastUsage.cache_read_input_tokens ?? 0
  const cacheWriteTokens = lastUsage.cache_creation_input_tokens ?? 0
  recordUsage({
    c,
    accountId,
    model,
    promptTokens: lastUsage.input_tokens ?? 0,
    completionTokens: lastUsage.output_tokens,
    totalTokens:
      (lastUsage.input_tokens ?? 0)
      + lastUsage.output_tokens
      + cacheReadTokens
      + cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ttftMs: timing?.ttftMs,
    tps: timing?.tps,
    streaming: true,
  })
}

export function recordAnthropicUsage(
  c: Context,
  accountId: string,
  response: AnthropicResponse,
  tps?: number,
): void {
  const usage = response.usage
  const model = c.get("model")
  if (!model) {
    return
  }

  // Anthropic API: input_tokens does NOT include cache tokens
  // (unlike OpenAI where prompt_tokens includes cached_tokens)
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  recordUsage({
    c,
    accountId,
    model,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens:
      usage.input_tokens
      + usage.output_tokens
      + cacheReadTokens
      + cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tps,
    streaming: false,
  })
}

/**
 * Prefer a later positive count over an earlier 0/undefined placeholder.
 * Gateways such as Volcengine Ark (glm-5.2) emit `input_tokens: 0` on
 * `message_start` and only report the real input count on the final
 * `message_delta`.
 */
function pickPositiveTokenCount(
  previous: number | undefined,
  next: number | undefined,
): number {
  if (typeof next === "number" && Number.isFinite(next) && next > 0) {
    return next
  }
  if (typeof previous === "number" && Number.isFinite(previous)) {
    return previous
  }
  if (typeof next === "number" && Number.isFinite(next)) {
    return next
  }
  return 0
}

function pickOptionalTokenCount(
  previous: number | undefined,
  next: number | undefined,
): number | undefined {
  if (typeof next === "number" && Number.isFinite(next) && next > 0) {
    return next
  }
  if (typeof previous === "number" && Number.isFinite(previous)) {
    return previous
  }
  if (typeof next === "number" && Number.isFinite(next)) {
    return next
  }
  return undefined
}

/** Estimate request input tokens from an Anthropic payload (fallback when
 * upstream reports no usage). Translates to the OpenAI shape first so the
 * local tokenizer sees the same content the copilot path estimates. */
export async function estimateAnthropicInputTokens(
  anthropicPayload: AnthropicMessagesPayload,
  opts?: { preserveHistoricalReasoning?: boolean },
): Promise<number> {
  const openAIPayload = translateToOpenAI(anthropicPayload, opts)
  const selectedModel = state.models?.data.find(
    (model) => model.id === openAIPayload.model,
  )
  if (!selectedModel) {
    return 0
  }
  try {
    const tokenCount = await getTokenCount(openAIPayload, selectedModel)
    return tokenCount.input
  } catch {
    return 0
  }
}

export function updateLastUsage(
  eventData: string,
  lastUsage: AnthropicStreamingUsage | undefined,
): AnthropicStreamingUsage | undefined {
  if (!eventData.includes('"usage"')) {
    return lastUsage
  }
  try {
    const parsed = JSON.parse(eventData) as {
      type?: string
      message?: {
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    }
    if (parsed.type === "message_start" && parsed.message?.usage) {
      const msgUsage = parsed.message.usage
      return {
        // Prefer a later non-zero input count (some gateways stub 0 here and
        // only report real input_tokens on the final message_delta).
        input_tokens: pickPositiveTokenCount(
          lastUsage?.input_tokens,
          msgUsage.input_tokens,
        ),
        output_tokens: pickPositiveTokenCount(
          lastUsage?.output_tokens,
          msgUsage.output_tokens,
        ),
        cache_read_input_tokens: pickOptionalTokenCount(
          lastUsage?.cache_read_input_tokens,
          msgUsage.cache_read_input_tokens,
        ),
        cache_creation_input_tokens: pickOptionalTokenCount(
          lastUsage?.cache_creation_input_tokens,
          msgUsage.cache_creation_input_tokens,
        ),
      }
    }
    if (parsed.type === "message_delta" && parsed.usage) {
      // Anthropic official streams usually only put output_tokens on
      // message_delta. Some Anthropic-compatible gateways (e.g. Volcengine
      // Ark glm-5.2) put the real input_tokens / cache_* counts here instead
      // of message_start — merge every present usage field.
      const deltaUsage = parsed.usage
      return {
        input_tokens: pickPositiveTokenCount(
          lastUsage?.input_tokens,
          deltaUsage.input_tokens,
        ),
        output_tokens: pickPositiveTokenCount(
          lastUsage?.output_tokens,
          deltaUsage.output_tokens,
        ),
        cache_read_input_tokens: pickOptionalTokenCount(
          lastUsage?.cache_read_input_tokens,
          deltaUsage.cache_read_input_tokens,
        ),
        cache_creation_input_tokens: pickOptionalTokenCount(
          lastUsage?.cache_creation_input_tokens,
          deltaUsage.cache_creation_input_tokens,
        ),
      }
    }
  } catch (error) {
    logger.warn("Failed to parse streaming event data:", error)
  }
  return lastUsage
}
