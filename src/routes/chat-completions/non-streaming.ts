import type { Context } from "hono"

import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import { logger } from "~/lib/logger"
import { recordUsage } from "~/lib/usage"

import { normalizeResponse } from "./normalize"
import { calculateTotalTokens } from "./usage"

export function handleNonStreamingResponse(
  c: Context,
  response: ChatCompletionResponse,
  estimatedInputTokens: number,
  elapsedMs?: number,
): void {
  if (logger.level >= 4) {
    logger.debug("Non-streaming response:", JSON.stringify(response))
  }
  const normalized = normalizeResponse(response)
  const usage = normalized.usage
  const model = c.get("model")
  const accountId = c.get("accountId")

  if (usage && model && accountId) {
    // prompt_tokens is the total input, including cache reads and cache
    // creation. The repo extends prompt_tokens_details with
    // cache_creation_input_tokens (Anthropic's cache-write concept), so
    // subtract both from the total when reporting non-cached prompt tokens.
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
    const cacheWriteTokens =
      usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0
    const tps =
      elapsedMs && elapsedMs > 0 ?
        usage.completion_tokens / (elapsedMs / 1000)
      : undefined
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: Math.max(
        usage.prompt_tokens - cacheReadTokens - cacheWriteTokens,
        0,
      ),
      completionTokens: usage.completion_tokens,
      totalTokens: calculateTotalTokens(usage),
      cacheReadTokens,
      cacheWriteTokens,
      tps,
      streaming: false,
      finishReason: normalized.choices[0]?.finish_reason,
    })
  } else if (model && accountId) {
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: estimatedInputTokens,
      completionTokens: 0,
      totalTokens: estimatedInputTokens,
      tps: 0,
      streaming: false,
    })
  }

  Object.assign(response, normalized)
}
