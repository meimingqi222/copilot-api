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
import {
  decodeMessagesRequest,
  encodeChatRequest,
} from "~/services/ir/codecs/messages-chat"

export interface DirectStreamingUsageOptions {
  estimatedInputTokens?: number
  finishReason?: string
}

export function recordDirectStreamingUsage(
  c: Context,
  accountId: string,
  lastUsage: AnthropicStreamingUsage | undefined,
  timing?: { ttftMs: number; tps: number },
  estimatedInputTokensOrOpts: number | DirectStreamingUsageOptions = 0,
): void {
  const estimatedInputTokens =
    typeof estimatedInputTokensOrOpts === "number" ?
      estimatedInputTokensOrOpts
    : (estimatedInputTokensOrOpts.estimatedInputTokens ?? 0)
  const finishReason =
    typeof estimatedInputTokensOrOpts === "number" ? undefined : (
      estimatedInputTokensOrOpts.finishReason
    )
  const model = c.get("model")
  if (!model) {
    return
  }

  if (!lastUsage) {
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
      finishReason: finishReason ?? "usage_missing",
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
    cacheWrite1hTokens: lastUsage.cache_creation?.ephemeral_1h_input_tokens,
    ttftMs: timing?.ttftMs,
    tps: timing?.tps,
    streaming: true,
    ...(finishReason !== undefined ? { finishReason } : {}),
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
    cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens,
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
  const openAIPayload = encodeChatRequest(
    decodeMessagesRequest(anthropicPayload),
    {
      preserveHistoricalReasoning: opts?.preserveHistoricalReasoning ?? false,
    },
  )
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

// Tracks explicitly translated message_start estimates, never native input-only usage,
// so a later pending frame can clear them without clobbering billed message_delta counts.
const estimatedMessageStarts = new WeakSet<AnthropicStreamingUsage>()

export function updateLastUsage(
  eventData: string,
  lastUsage: AnthropicStreamingUsage | undefined,
  estimatedMessageStart = false,
): AnthropicStreamingUsage | undefined {
  if (!eventData.includes('"usage"')) {
    return lastUsage
  }
  try {
    const parsed = JSON.parse(eventData) as {
      type?: string
      message?: {
        usage?: Partial<AnthropicStreamingUsage>
      }
      usage?: Partial<AnthropicStreamingUsage>
    }
    const currentUsage =
      parsed.type === "message_start" ? parsed.message?.usage
      : parsed.type === "message_delta" ? parsed.usage
      : undefined
    if (currentUsage?.usage_status === "pending") {
      // Explicit pending zeros replace message_start estimates, not billed counts.
      if (
        lastUsage
        && lastUsage.usage_status !== "pending"
        && !estimatedMessageStarts.has(lastUsage)
      ) {
        return lastUsage
      }
      return { ...currentUsage, output_tokens: currentUsage.output_tokens ?? 0 }
    }
    if (parsed.type === "message_start" && parsed.message?.usage) {
      const msgUsage = parsed.message.usage
      const next: AnthropicStreamingUsage = {
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
        cache_creation: msgUsage.cache_creation ?? lastUsage?.cache_creation,
        cache_creation_input_tokens: pickOptionalTokenCount(
          lastUsage?.cache_creation_input_tokens,
          msgUsage.cache_creation_input_tokens,
        ),
      }
      if (
        estimatedMessageStart
        && (!lastUsage || estimatedMessageStarts.has(lastUsage))
        && next.output_tokens === 0
        && (next.cache_read_input_tokens ?? 0) === 0
        && (next.cache_creation_input_tokens ?? 0) === 0
      ) {
        estimatedMessageStarts.add(next)
      }
      return next
    }
    if (parsed.type === "message_delta" && parsed.usage) {
      // Anthropic official streams usually only put output_tokens on
      // message_delta. Some Anthropic-compatible gateways (e.g. Volcengine
      // Ark glm-5.2) put the real input_tokens / cache_* counts here instead
      // of message_start — merge every present usage field.
      const deltaUsage = parsed.usage
      const next: AnthropicStreamingUsage = {
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
        cache_creation: deltaUsage.cache_creation ?? lastUsage?.cache_creation,
        cache_creation_input_tokens: pickOptionalTokenCount(
          lastUsage?.cache_creation_input_tokens,
          deltaUsage.cache_creation_input_tokens,
        ),
      }
      const confirmedBilled =
        (deltaUsage.input_tokens ?? 0) > 0
        || (deltaUsage.output_tokens ?? 0) > 0
        || (deltaUsage.cache_read_input_tokens ?? 0) > 0
        || (deltaUsage.cache_creation_input_tokens ?? 0) > 0
      if (
        lastUsage
        && estimatedMessageStarts.has(lastUsage)
        && !confirmedBilled
      ) {
        estimatedMessageStarts.add(next)
      }
      return next
    }
  } catch (error) {
    logger.warn("Failed to parse streaming event data:", error)
  }
  return lastUsage
}
