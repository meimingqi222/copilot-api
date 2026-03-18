import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { getAccountForModel } from "~/lib/accounts"
import { awaitApproval } from "~/lib/approval"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { checkRateLimit, RateLimitQueueFullError } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { getTokenCount } from "~/lib/tokenizer"
import { incrementUserTokens } from "~/lib/users"
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
type SSEStream = Parameters<Parameters<typeof streamSSE>[1]>[0]

interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
}

interface UsageRecordInput {
  c: Context
  accountId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
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

  const account = getAccountForModel(payload.model)

  await checkRateLimitOrThrow(account.id, signal)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const estimatedInputTokens = await calculateTokens(payload, selectedModel)

  if (state.manualApprove) await awaitApproval()

  payload = applyMaxTokens(payload, selectedModel)

  const result = await createChatCompletions(
    payload,
    signal,
    resolveInitiator(c, payload),
  )
  const { accountId } = result

  c.set("accountId" as never, accountId)
  c.set("model" as never, payload.model)

  if (isChatCompletionResponse(result.response)) {
    handleNonStreamingResponse(c, result.response, estimatedInputTokens)
    return c.json(result.response)
  }

  const response = result.response
  return handleStreamingResponse(c, response, estimatedInputTokens)
}

async function checkRateLimitOrThrow(
  accountId: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await checkRateLimit(accountId, signal)
  } catch (e) {
    if (e instanceof RateLimitQueueFullError) {
      throw new RateLimitError(e.message)
    }
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new AbortError()
    }
    throw e
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RateLimitError"
  }
}

export class AbortError extends Error {
  constructor() {
    super("Abort")
    this.name = "AbortError"
  }
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
    recordUsage(
      createUsageRecord({
        c,
        accountId,
        model,
        promptTokens: Math.max(usage.prompt_tokens - cacheReadTokens, 0),
        completionTokens: usage.completion_tokens,
        totalTokens: calculateTotalTokens(usage),
        cacheReadTokens,
        cacheWriteTokens,
      }),
    )
  } else if (model && accountId) {
    recordUsage(
      createUsageRecord({
        c,
        accountId,
        model,
        promptTokens: estimatedInputTokens,
        completionTokens: 0,
        totalTokens: estimatedInputTokens,
      }),
    )
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
    let lastUsage: UsageInfo | undefined
    let recordedOnAbort = false
    const pingInterval = createPingInterval(stream)

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
        await stream.writeSSE({
          data: JSON.stringify(normalizeChunk(chunk)),
        } as SSEMessage)
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

function createPingInterval(stream: SSEStream): ReturnType<typeof setInterval> {
  const PING_INTERVAL_MS = 5_000
  return setInterval(async () => {
    try {
      await stream.writeSSE({ event: "ping", data: '{"type": "ping"}' })
    } catch {
      // Stream already closed; clear interval in finally below.
    }
  }, PING_INTERVAL_MS)
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
    recordUsage(
      createUsageRecord({
        c,
        accountId,
        model,
        promptTokens: Math.max(lastUsage.prompt_tokens - cacheReadTokens, 0),
        completionTokens: lastUsage.completion_tokens,
        totalTokens: calculateTotalTokens(lastUsage),
        cacheReadTokens,
        cacheWriteTokens,
      }),
    )
    return true
  }

  if (onlyWhenUsageExists) {
    return false
  }

  recordUsage(
    createUsageRecord({
      c,
      accountId,
      model,
      promptTokens: estimatedInputTokens,
      completionTokens: 0,
      totalTokens: estimatedInputTokens,
    }),
  )
  return true
}

function calculateTotalTokens(usage: UsageInfo): number {
  return usage.total_tokens
}

function createUsageRecord(input: UsageRecordInput): UsageRecordInput {
  return input
}

function recordUsage(input: UsageRecordInput): void {
  const {
    c,
    accountId,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  } = input

  void trackUserTokenUsage(c, totalTokens)

  try {
    const now = Date.now()
    const pricing = statsStore.getModelPricing(model)
    const cost =
      pricing ?
        (promptTokens / 1000) * pricing.promptPricePer1k
        + (completionTokens / 1000) * pricing.completionPricePer1k
        + (cacheReadTokens / 1000) * pricing.cacheReadPricePer1k
        + (cacheWriteTokens / 1000) * pricing.cacheWritePricePer1k
      : 0

    statsStore.recordUsage({
      date: new Date(now).toISOString().split("T")[0] ?? "",
      accountId,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      timestamp: now,
    })
    consola.debug(
      `Recorded usage: ${model} - ${totalTokens} tokens ($${cost.toFixed(4)})`,
    )
  } catch (error) {
    consola.warn("Failed to record usage:", error)
  }
}

const isChatCompletionResponse = (
  response: CopilotStream | ChatCompletionResponse,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

async function trackUserTokenUsage(c: Context, tokens: number): Promise<void> {
  if (tokens <= 0) return

  const userId = c.get("userId" as never) as string | undefined
  if (!userId) return

  try {
    await incrementUserTokens(userId, tokens)
    consola.debug(`Tracked ${tokens} tokens for user ${userId}`)
  } catch (error) {
    consola.warn("Failed to track user token usage:", error)
  }
}
