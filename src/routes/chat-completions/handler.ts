import type { Context } from "hono"

import consola from "consola"

import type { RequestAdmission } from "~/lib/request-admission"

import { canonicalModelId } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import { handleSseStream, writeSseEvent } from "~/lib/sse"
import { state } from "~/lib/state"
import { computeStreamingTiming } from "~/lib/timing"
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage } from "~/lib/usage"
import { isChatCompletionResponse, isNullish } from "~/lib/utils"
import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  extractMessageContentFromChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { dispatchChatCompletions } from "~/services/dispatch/chat-completions"

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
  timing?: { ttftMs: number; tps: number }
}

export async function handleCompletion(c: Context) {
  const signal = c.req.raw.signal
  let payload = await c.req.json<ChatCompletionsPayload>()
  if (consola.level >= 4) {
    consola.debug("Request payload:", JSON.stringify(payload).slice(-400))
  }

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

  const messageContent =
    extractMessageContentFromChatCompletionsPayload(payload)
  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: payload.model,
    endpoint: "chat",
    maxTokens:
      typeof payload.max_tokens === "number" ? payload.max_tokens : undefined,
    stream: payload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromOpenAIMessages(
      payload.messages,
      c.req.header("user-agent"),
    ),
    messageContent,
  })

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  payload = applyMaxTokens(payload, selectedModel)

  if (!payload.stream) {
    const estimatedInputTokens = await calculateTokens(payload, selectedModel)
    const nonStreamStart = Date.now()
    const result = await dispatchChatCompletions(payload, admission, signal, c)

    c.set("accountId", result.accountId)
    c.set("model", payload.model)

    if (isChatCompletionResponse(result.response)) {
      const elapsed = Date.now() - nonStreamStart
      handleNonStreamingResponse(
        c,
        result.response,
        estimatedInputTokens,
        elapsed,
      )
      return c.json(result.response)
    }

    return handleStreamingResponse(c, result.response, estimatedInputTokens)
  }

  const estimatedInputTokens = await calculateTokens(payload, selectedModel)

  return handleStreamingCompletion(c, {
    payload,
    admission,
    signal,
    selectedModel,
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

function handleNonStreamingResponse(
  c: Context,
  response: ChatCompletionResponse,
  estimatedInputTokens: number,
  elapsedMs?: number,
): void {
  if (consola.level >= 4) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
  }
  const normalized = normalizeResponse(response)
  const usage = normalized.usage
  const model = c.get("model")
  const accountId = c.get("accountId")

  if (usage && model && accountId) {
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
      promptTokens: Math.max(usage.prompt_tokens - cacheReadTokens, 0),
      completionTokens: usage.completion_tokens,
      totalTokens: calculateTotalTokens(usage),
      cacheReadTokens,
      cacheWriteTokens,
      tps,
      streaming: false,
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

function handleStreamingResponse(
  c: Context,
  response: CopilotStream,
  estimatedInputTokens: number,
) {
  consola.debug("Streaming response")
  const model = c.get("model")
  const accountId = c.get("accountId")

  let lastUsage: UsageInfo | undefined
  let usageRecorded = false
  let firstChunkTs: number | undefined
  const streamStart = Date.now()

  return handleSseStream(
    c,
    async (stream) => {
      try {
        for await (const rawEvent of response) {
          if (rawEvent.data === "[DONE]") {
            break
          }
          if (!rawEvent.data) {
            continue
          }

          if (!firstChunkTs) {
            firstChunkTs = Date.now()
          }

          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
          if (consola.level >= 4) {
            consola.debug("Streaming raw event:", JSON.stringify(rawEvent))
          }
          if (chunk.usage) {
            lastUsage = chunk.usage
          }
          await writeSseEvent(stream, JSON.stringify(normalizeChunk(chunk)))
        }
      } finally {
        if (!usageRecorded) {
          usageRecorded = recordStreamingUsage({
            c,
            accountId,
            model,
            lastUsage,
            estimatedInputTokens,
            timing: computeStreamingTiming(
              streamStart,
              firstChunkTs,
              lastUsage?.completion_tokens ?? 0,
            ),
          })
        }
      }
    },
    {
      onAbort: () => {
        usageRecorded = recordStreamingUsage({
          c,
          accountId,
          model,
          lastUsage,
          estimatedInputTokens,
          timing: computeStreamingTiming(
            streamStart,
            firstChunkTs,
            lastUsage?.completion_tokens ?? 0,
          ),
        })
      },
    },
  )
}

function recordStreamingUsage(input: StreamUsageInput): boolean {
  const {
    c,
    accountId,
    model,
    lastUsage,
    estimatedInputTokens,
    onlyWhenUsageExists = false,
    timing,
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
      ttftMs: timing?.ttftMs,
      tps: timing?.tps,
      streaming: true,
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
  })
  return true
}

function calculateTotalTokens(usage: UsageInfo): number {
  return usage.total_tokens
}

interface StreamingCompletionOptions {
  payload: ChatCompletionsPayload
  admission: RequestAdmission
  signal: AbortSignal | undefined
  selectedModel: CachedModel | undefined
  estimatedInputTokens: number
}

function handleStreamingCompletion(
  c: Context,
  options: StreamingCompletionOptions,
) {
  let lastUsage: UsageInfo | undefined
  let usageRecorded = false
  let accountId: string | undefined
  let firstChunkTs: number | undefined
  let streamStart = 0
  return handleSseStream(
    c,
    async (stream) => {
      const { payload, admission, signal, estimatedInputTokens } = options
      const model = payload.model

      try {
        const dispatchStart = Date.now()
        const result = await dispatchChatCompletions(
          payload,
          admission,
          signal,
          c,
        )
        accountId = result.accountId

        c.set("accountId", accountId)
        c.set("model", model)

        if (isChatCompletionResponse(result.response)) {
          const elapsed = Date.now() - dispatchStart
          handleNonStreamingResponse(
            c,
            result.response,
            estimatedInputTokens,
            elapsed,
          )
          await writeSseEvent(stream, JSON.stringify(result.response))
          usageRecorded = true
          return
        }

        streamStart = dispatchStart
        for await (const rawEvent of result.response) {
          if (rawEvent.data === "[DONE]") {
            break
          }
          if (!rawEvent.data) {
            continue
          }

          if (!firstChunkTs) {
            firstChunkTs = Date.now()
          }

          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
          if (consola.level >= 4) {
            consola.debug("Streaming raw event:", JSON.stringify(rawEvent))
          }
          if (chunk.usage) {
            lastUsage = chunk.usage
          }
          await writeSseEvent(stream, JSON.stringify(normalizeChunk(chunk)))
        }
      } catch (error) {
        consola.error("Streaming error:", error)
        const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
        if (knownError?.status === 499) {
          return
        }
        const errorMessage =
          knownError?.message
          ?? (error instanceof Error ? error.message : "Internal server error")
        const errorType =
          knownError?.type
          ?? (error instanceof HTTPError && error.response.status === 429 ?
            "rate_limit_error"
          : "error")
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
        if (!usageRecorded) {
          recordStreamingUsage({
            c,
            accountId,
            model,
            lastUsage,
            estimatedInputTokens,
            timing: computeStreamingTiming(
              streamStart,
              firstChunkTs,
              lastUsage?.completion_tokens ?? 0,
            ),
          })
        }
      }
    },
    {
      onAbort: () => {
        usageRecorded = recordStreamingUsage({
          c,
          accountId,
          model: options.payload.model,
          lastUsage,
          estimatedInputTokens: options.estimatedInputTokens,
          timing: computeStreamingTiming(
            streamStart,
            firstChunkTs,
            lastUsage?.completion_tokens ?? 0,
          ),
        })
      },
    },
  )
}
