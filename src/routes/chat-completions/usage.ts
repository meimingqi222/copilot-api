import type { Context } from "hono"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { logger } from "~/lib/logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage } from "~/lib/usage"
import { isNullish } from "~/lib/utils"

type CachedModel = NonNullable<typeof state.models>["data"][number]

export interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export interface StreamUsageInput {
  c: Context
  accountId?: string
  model?: string
  lastUsage?: UsageInfo
  estimatedInputTokens: number
  onlyWhenUsageExists?: boolean
  timing?: { ttftMs: number; tps: number }
  finishReason?: string
}

export async function calculateTokens(
  payload: ChatCompletionsPayload,
  selectedModel: CachedModel | undefined,
): Promise<number> {
  try {
    if (!selectedModel) {
      logger.warn("No model selected, skipping token count calculation")
      return 0
    }

    const tokenCount = await getTokenCount(payload, selectedModel)
    // Local estimate only — not upstream billing. `input` includes all
    // messages (assistant history included); `history` is the assistant
    // subset of that total.
    logger.info(
      `Estimated input tokens: ${tokenCount.input} (history: ${tokenCount.history})`,
    )
    return tokenCount.input
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
    return 0
  }
}

export function applyMaxTokens(
  payload: ChatCompletionsPayload,
  selectedModel: CachedModel | undefined,
): ChatCompletionsPayload {
  if (isNullish(payload.max_tokens)) {
    const newPayload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits?.max_output_tokens,
    }
    logger.debug("Set max_tokens to:", JSON.stringify(newPayload.max_tokens))
    return newPayload
  }
  return payload
}

export function recordStreamingUsage(input: StreamUsageInput): boolean {
  const {
    c,
    accountId,
    model,
    lastUsage,
    estimatedInputTokens,
    onlyWhenUsageExists = false,
    timing,
    finishReason,
  } = input
  if (!accountId || !model) {
    return false
  }

  if (lastUsage) {
    const cacheReadTokens = lastUsage.prompt_tokens_details?.cached_tokens ?? 0
    const cacheWriteTokens =
      lastUsage.prompt_tokens_details?.cache_creation_input_tokens ?? 0
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: Math.max(
        lastUsage.prompt_tokens - cacheReadTokens - cacheWriteTokens,
        0,
      ),
      completionTokens: lastUsage.completion_tokens,
      totalTokens: calculateTotalTokens(lastUsage),
      cacheReadTokens,
      cacheWriteTokens,
      ttftMs: timing?.ttftMs,
      tps: timing?.tps,
      streaming: true,
      finishReason,
    })
    return true
  }

  if (onlyWhenUsageExists) {
    return false
  }

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
    finishReason,
  })
  return true
}

export function calculateTotalTokens(usage: UsageInfo): number {
  return usage.total_tokens
}
