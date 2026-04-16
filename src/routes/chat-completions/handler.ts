import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { canonicalModelId, getAccountForModel } from "~/lib/accounts"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { checkAccountRateLimitOrThrow } from "~/lib/request-lifecycle"
import { createSsePingInterval, writeSseEvent } from "~/lib/sse"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage } from "~/lib/usage"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { inferInitiatorFromOpenAIMessages } from "./initiator"
import { normalizeChunk, normalizeResponse } from "./normalize"

type CopilotStream = AsyncIterable<{ data?: string }>
type CachedModel = NonNullable<typeof state.models>["data"][number]

interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
}

interface StreamUsageInput {
  c: Context
  accountId?: string
  model?: string
  lastUsage?: UsageInfo
  estimatedInputTokens: number
  onlyWhenUsageExists?: boolean
}

export async function handleCompletion(c: Context) {
  const signal = c.req.raw.signal
  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Normalize model name (e.g., "z-ai/glm5" -> "z-ai/glm-5.1")
  const normalizedModel = payload.model ? canonicalModelId(payload.model) : ""
  payload = {
    ...payload,
    model:
      normalizedModel
      // Use a Copilot-compatible default model (with vendor prefix)
      // This model ID is recognized by Copilot's backend
      || "gpt-5-mini",
  }

  const account = getAccountForModel(payload.model)
  if ((account.provider ?? "copilot") === "copilot") {
    await checkAccountRateLimitOrThrow(account.id, signal)
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const estimatedInputTokens = await calculateTokens(payload, selectedModel)

  if (state.manualApprove) await awaitApproval()

  payload = applyMaxTokens(payload, selectedModel)

  if (!payload.stream) {
    const result = await createChatCompletions(
      payload,
      signal,
      resolveInitiator(c, payload),
    )

    c.set("accountId" as never, result.accountId)
    c.set("model" as never, payload.model)

    if (isChatCompletionResponse(result.response)) {
      handleNonStreamingResponse(c, result.response, estimatedInputTokens)
      return c.json(result.response)
    }

    return handleStreamingResponse(c, result.response, estimatedInputTokens)
  }

  return handleStreamingCompletion(c, {
    payload,
    signal,
    estimatedInputTokens,
  })
}

async function calculateTokens(
  payload: ChatCompletionsPayload,
  selectedModel: CachedModel | undefined,
): Promise<number> {
  try {
    if (!selectedModel) {
      consola.warn("No model selected, skipping token count calculation")
      return 0
    }

    const tokenCount = await getTokenCount(payload, selectedModel)
    consola.info("Current token count:", tokenCount)
    return tokenCount.input + tokenCount.output
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
    return 0
  }
}

function applyMaxTokens(
  payload: ChatCompletionsPayload,
  selectedModel: CachedModel | undefined,
): ChatCompletionsPayload {
  if (isNullish(payload.max_tokens)) {
    const newPayload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits?.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(newPayload.max_tokens))
    return newPayload
  }
  return payload
}

function resolveInitiator(
  c: Context,
  payload: ChatCompletionsPayload,
): "agent" | "user" | undefined {
  const inferredInitiator = inferInitiatorFromOpenAIMessages(
    payload.messages,
    c.req.header("user-agent"),
  )
  const { clientInitiator, initiator, trustedClientAgent } =
    resolveInitiatorWithClientHeader(c, inferredInitiator)
  consola.debug(
    "X-Initiator: client=%s trusted_agent=%s final=%s",
    clientInitiator ?? "(none)",
    trustedClientAgent,
    initiator,
  )
  return initiator
}

function handleNonStreamingResponse(
  c: Context,
  response: ChatCompletionResponse,
  estimatedInputTokens: number,
): void {
  consola.debug("Non-streaming response:", JSON.stringify(response))
  const normalized = normalizeResponse(response)
  const usage = normalized.usage
  const model = c.get("model" as never) as string | undefined
  const accountId = c.get("accountId" as never) as string | undefined

  if (usage && model && accountId) {
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
    const cacheWriteTokens =
      usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: Math.max(usage.prompt_tokens - cacheReadTokens, 0),
      completionTokens: usage.completion_tokens,
      totalTokens: calculateTotalTokens(usage),
      cacheReadTokens,
      cacheWriteTokens,
    })
  } else if (model && accountId) {
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: estimatedInputTokens,
      completionTokens: 0,
      totalTokens: estimatedInputTokens,
    })
  }

  Object.assign(response, normalized)
}

function handleStreamingResponse(
  c: Context,
  response: CopilotStream,
  estimatedInputTokens: number,
) {
  consola.debug("Streaming response")
  const model = c.get("model" as never) as string | undefined
  const accountId = c.get("accountId" as never) as string | undefined

  return streamSSE(c, async (stream) => {
    const pingInterval = createSsePingInterval(stream)
    let lastUsage: UsageInfo | undefined
    let recordedOnAbort = false

    try {
      for await (const rawEvent of response) {
        if (rawEvent.data === "[DONE]") {
          break
        }
        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        consola.debug("Streaming raw event:", JSON.stringify(rawEvent))
        lastUsage = chunk.usage ?? lastUsage
        await writeSseEvent(stream, JSON.stringify(normalizeChunk(chunk)))
      }
    } catch (error) {
      if (isAbortError(error)) {
        consola.debug("Stream aborted (client disconnected)")
        recordedOnAbort = recordStreamingUsage({
          c,
          accountId,
          model,
          lastUsage,
          estimatedInputTokens,
          onlyWhenUsageExists: true,
        })
        return
      }
      throw error
    } finally {
      clearInterval(pingInterval)
      if (!recordedOnAbort) {
        recordStreamingUsage({
          c,
          accountId,
          model,
          lastUsage,
          estimatedInputTokens,
        })
      }
    }
  })
}

function recordStreamingUsage(input: StreamUsageInput): boolean {
  const {
    c,
    accountId,
    model,
    lastUsage,
    estimatedInputTokens,
    onlyWhenUsageExists = false,
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
      promptTokens: Math.max(lastUsage.prompt_tokens - cacheReadTokens, 0),
      completionTokens: lastUsage.completion_tokens,
      totalTokens: calculateTotalTokens(lastUsage),
      cacheReadTokens,
      cacheWriteTokens,
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
  })
  return true
}

function calculateTotalTokens(usage: UsageInfo): number {
  return usage.total_tokens
}

const isChatCompletionResponse = (
  response: CopilotStream | ChatCompletionResponse,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

interface StreamingCompletionOptions {
  payload: ChatCompletionsPayload
  signal: AbortSignal | undefined
  estimatedInputTokens: number
}

function handleStreamingCompletion(
  c: Context,
  options: StreamingCompletionOptions,
) {
  return streamSSE(c, async (stream) => {
    const { payload, signal, estimatedInputTokens } = options
    const pingInterval = createSsePingInterval(stream)
    let lastUsage: UsageInfo | undefined
    let recordedOnAbort = false
    let accountId: string | undefined
    const model = payload.model

    try {
      const result = await createChatCompletions(
        payload,
        signal,
        resolveInitiator(c, payload),
      )
      accountId = result.accountId

      c.set("accountId" as never, accountId)
      c.set("model" as never, model)

      if (isChatCompletionResponse(result.response)) {
        handleNonStreamingResponse(c, result.response, estimatedInputTokens)
        await writeSseEvent(stream, JSON.stringify(result.response))
        return
      }

      for await (const rawEvent of result.response) {
        if (rawEvent.data === "[DONE]") {
          break
        }
        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        consola.debug("Streaming raw event:", JSON.stringify(rawEvent))
        lastUsage = chunk.usage ?? lastUsage
        await writeSseEvent(stream, JSON.stringify(normalizeChunk(chunk)))
      }
    } catch (error) {
      if (isAbortError(error)) {
        consola.debug("Stream aborted (client disconnected)")
        recordedOnAbort = recordStreamingUsage({
          c,
          accountId,
          model,
          lastUsage,
          estimatedInputTokens,
          onlyWhenUsageExists: true,
        })
        return
      }
      // Write error to SSE stream
      consola.error("Streaming error:", error)
      const errorMessage =
        error instanceof Error ? error.message : "Internal server error"
      const errorType =
        error instanceof HTTPError && error.response.status === 429 ?
          "rate_limit_error"
        : "error"
      await writeSseEvent(
        stream,
        JSON.stringify({
          error: {
            message: errorMessage,
            type: errorType,
          },
        }),
      )
      throw error
    } finally {
      clearInterval(pingInterval)
      if (!recordedOnAbort) {
        recordStreamingUsage({
          c,
          accountId,
          model,
          lastUsage,
          estimatedInputTokens,
        })
      }
    }
  })
}
