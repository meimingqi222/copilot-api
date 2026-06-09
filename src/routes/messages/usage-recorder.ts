import type { Context } from "hono"

import consola from "consola"

import { recordUsage } from "~/lib/usage"

import type {
  AnthropicResponse,
  AnthropicStreamingUsage,
} from "./anthropic-types"

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
): void {
  const model = c.get("model")
  if (!model || !lastUsage) {
    return
  }

  const cacheReadTokens = lastUsage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens =
    lastUsage.prompt_tokens_details?.cache_creation_input_tokens ?? 0
  recordUsage({
    c,
    accountId,
    model,
    promptTokens: Math.max(lastUsage.prompt_tokens - cacheReadTokens, 0),
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
): void {
  const model = c.get("model")
  if (!model || !lastUsage) {
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
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }
      usage?: { output_tokens: number }
    }
    if (parsed.type === "message_start" && parsed.message?.usage) {
      const msgUsage = parsed.message.usage
      return {
        input_tokens: msgUsage.input_tokens ?? 0,
        output_tokens: lastUsage?.output_tokens ?? 0,
        cache_read_input_tokens: msgUsage.cache_read_input_tokens,
        cache_creation_input_tokens: msgUsage.cache_creation_input_tokens,
      }
    }
    if (parsed.type === "message_delta" && parsed.usage) {
      return {
        ...(lastUsage ?? { input_tokens: 0, output_tokens: 0 }),
        output_tokens: parsed.usage.output_tokens,
      }
    }
  } catch (error) {
    consola.warn("Failed to parse streaming event data:", error)
  }
  return lastUsage
}
