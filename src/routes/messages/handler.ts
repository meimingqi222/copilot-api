import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { getAccountForModel } from "~/lib/accounts"
import { awaitApproval } from "~/lib/approval"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { checkRateLimit, RateLimitQueueFullError } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { incrementUserTokens } from "~/lib/users"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  supportsMessagesApi,
  type CopilotStreamEventLike,
} from "~/services/copilot/responses-api"

import {
  createInitialStreamState,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamState,
} from "./anthropic-types"
import { inferInitiatorFromAnthropicMessages } from "./initiator"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

type SSEStream = Parameters<Parameters<typeof streamSSE>[1]>[0]
type CopilotStream = AsyncIterable<{ data?: string; event?: string }>

interface HandleStreamingResponseOptions {
  stream: SSEStream
  response: CopilotStream
  clientSignal: AbortSignal
  c?: Context
  accountId: string
}

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

export async function handleCompletion(c: Context) {
  const signal = c.req.raw.signal

  try {
    await checkRateLimit(signal)
  } catch (e) {
    if (e instanceof RateLimitQueueFullError) {
      return c.json({ error: { message: e.message, type: "error" } }, 503)
    }
    if (e instanceof DOMException && e.name === "AbortError") {
      return new Response(null, { status: 499 })
    }
    throw e
  }

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const anthropicBeta = c.req.header("anthropic-beta")
  const anthropicVersion = c.req.header("anthropic-version")
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))
  const inferredInitiator = inferInitiatorFromAnthropicMessages(
    anthropicPayload.messages,
    anthropicBeta,
  )
  const { clientInitiator, initiator, trustedClientAgent } =
    resolveInitiatorWithClientHeader(c, inferredInitiator)

  consola.debug(
    "X-Initiator: client=%s inferred=%s trusted_agent=%s final=%s",
    clientInitiator ?? "(none)",
    inferredInitiator,
    trustedClientAgent,
    initiator,
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const account = getAccountForModel(anthropicPayload.model)
  if (supportsMessagesApi(anthropicPayload.model, account)) {
    const result = await createMessages(anthropicPayload, signal, {
      initiatorOverride: initiator,
      forwardedHeaders: {
        anthropicBeta,
        anthropicVersion,
      },
    })
    const { accountId } = result

    c.set("accountId" as never, accountId)
    c.set("model" as never, anthropicPayload.model)

    if (isDirectAnthropicResponse(result.response)) {
      recordAnthropicUsage(c, accountId, result.response)
      return c.json(result.response)
    }

    const streamResponse = result.response
    return streamSSE(c, (stream) =>
      handleDirectStreamingResponse({
        stream,
        response: streamResponse,
        clientSignal: signal,
        c,
        accountId,
      }),
    )
  }

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  logDuplicateToolCallIds(openAIPayload.messages)

  const result = await createChatCompletions(openAIPayload, signal, initiator)
  const { accountId } = result

  c.set("accountId" as never, accountId)
  c.set("model" as never, openAIPayload.model)

  if (isNonStreaming(result)) {
    return c.json(handleNonStreamingResponse(c, accountId, result.response))
  }

  return streamSSE(c, (stream) =>
    handleStreamingResponse({
      stream,
      response: result.response,
      clientSignal: signal,
      c,
      accountId,
    }),
  )
}

function logDuplicateToolCallIds(
  messages: Array<{ role: string; tool_calls?: Array<{ id: string }> }>,
): void {
  const allToolCallIds = messages.flatMap((message) =>
    message.tool_calls ? message.tool_calls.map((toolCall) => toolCall.id) : [],
  )
  const duplicateIds = allToolCallIds.filter(
    (id, index) => allToolCallIds.indexOf(id) !== index,
  )

  if (duplicateIds.length === 0) {
    return
  }

  consola.error("Duplicate tool_call ids detected:", duplicateIds)
  consola.error(
    "Messages with tool_calls:",
    JSON.stringify(
      messages
        .filter((message) => message.tool_calls)
        .map((message) => ({
          role: message.role,
          ids: message.tool_calls?.map((toolCall) => toolCall.id),
        })),
    ),
  )
}

function handleNonStreamingResponse(
  c: Context,
  accountId: string,
  response: ChatCompletionResponse,
) {
  consola.debug(
    "Non-streaming response from Copilot:",
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateToAnthropic(response)
  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )

  const usage = anthropicResponse.usage
  const model = c.get("model" as never) as string | undefined

  if (model) {
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
    recordUsage(
      createUsageRecord({
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
      }),
    )
  }

  return anthropicResponse
}

async function handleStreamingResponse({
  stream,
  response,
  clientSignal,
  c,
  accountId,
}: HandleStreamingResponseOptions): Promise<void> {
  const streamState = createInitialStreamState()
  let lastUsage: UsageInfo | undefined

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
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      lastUsage = chunk.usage ?? lastUsage
      await writeAnthropicEvents(
        stream,
        translateChunkToAnthropicEvents(chunk, streamState),
      )
    }

    await sendSyntheticErrorIfNeeded(
      stream,
      streamState,
      "Upstream closed stream without finish_reason",
    )
  } catch (error) {
    if (
      await handleStreamingError({
        error,
        clientSignal,
        stream,
        streamState,
      })
    ) {
      return
    }
    throw error
  } finally {
    clearInterval(pingInterval)
    if (c) {
      recordStreamingUsage(c, accountId, lastUsage)
    }
  }
}

async function handleDirectStreamingResponse({
  stream,
  response,
  clientSignal,
  c,
  accountId,
}: HandleStreamingResponseOptions): Promise<void> {
  let lastUsage:
    | {
        input_tokens?: number
        output_tokens: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    | undefined

  const pingInterval = createPingInterval(stream)

  try {
    for await (const rawEvent of response) {
      if (!rawEvent.data) {
        continue
      }

      const parsed = JSON.parse(rawEvent.data) as {
        type?: string
        usage?: typeof lastUsage
      }
      if (parsed.type === "message_delta" && parsed.usage) {
        lastUsage = parsed.usage
      }

      await stream.writeSSE({
        ...(rawEvent.event ? { event: rawEvent.event } : {}),
        data: rawEvent.data,
      })
    }
  } catch (error) {
    if (
      error instanceof DOMException
      && error.name === "AbortError"
      && clientSignal.aborted
    ) {
      return
    }
    throw error
  } finally {
    clearInterval(pingInterval)
    if (c) {
      recordDirectStreamingUsage(c, accountId, lastUsage)
    }
  }
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

async function writeAnthropicEvents(
  stream: SSEStream,
  events: Array<ReturnType<typeof translateChunkToAnthropicEvents>[number]>,
): Promise<void> {
  for (const event of events) {
    consola.debug("Translated Anthropic event:", JSON.stringify(event))
    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event),
    })
  }
}

async function handleStreamingError(input: {
  error: unknown
  clientSignal: AbortSignal
  stream: SSEStream
  streamState: AnthropicStreamState
}): Promise<boolean> {
  const { error, clientSignal, stream, streamState } = input
  if (error instanceof DOMException && error.name === "AbortError") {
    if (clientSignal.aborted) {
      consola.debug("Stream aborted (client disconnected)")
      return true
    }

    const sent = await sendSyntheticErrorIfNeeded(
      stream,
      streamState,
      "Upstream aborted stream before finish_reason",
    )
    if (sent) {
      return true
    }

    consola.warn("Stream aborted unexpectedly before first response event")
    return true
  }

  const sent = await sendSyntheticErrorIfNeeded(
    stream,
    streamState,
    "Unexpected streaming error",
  )
  return sent
}

function recordStreamingUsage(
  c: Context,
  accountId: string,
  lastUsage: UsageInfo | undefined,
): void {
  const model = c.get("model" as never) as string | undefined
  if (!model || !lastUsage) {
    return
  }

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
      totalTokens: lastUsage.total_tokens,
      cacheReadTokens,
      cacheWriteTokens,
    }),
  )
}

function recordDirectStreamingUsage(
  c: Context,
  accountId: string,
  lastUsage:
    | {
        input_tokens?: number
        output_tokens: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    | undefined,
): void {
  const model = c.get("model" as never) as string | undefined
  if (!model || !lastUsage) {
    return
  }

  const cacheReadTokens = lastUsage.cache_read_input_tokens ?? 0
  const cacheWriteTokens = lastUsage.cache_creation_input_tokens ?? 0
  recordUsage(
    createUsageRecord({
      c,
      accountId,
      model,
      promptTokens: Math.max(
        (lastUsage.input_tokens ?? 0) - cacheReadTokens,
        0,
      ),
      completionTokens: lastUsage.output_tokens,
      totalTokens:
        (lastUsage.input_tokens ?? 0)
        + lastUsage.output_tokens
        + cacheReadTokens
        + cacheWriteTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }),
  )
}

async function sendSyntheticErrorIfNeeded(
  stream: SSEStream,
  streamState: AnthropicStreamState,
  reason: string,
): Promise<boolean> {
  if (!streamState.messageStartSent || streamState.messageStopSent) {
    return false
  }

  consola.warn(`${reason}, sending error event`)
  const errorEvent = translateErrorToAnthropicErrorEvent()
  await stream.writeSSE({
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  })
  return true
}

const isNonStreaming = (
  result:
    | { accountId: string; response: CopilotStream }
    | { accountId: string; response: ChatCompletionResponse },
): result is { accountId: string; response: ChatCompletionResponse } =>
  Object.hasOwn(result.response, "choices")

function isDirectAnthropicResponse(
  response: AsyncIterable<CopilotStreamEventLike> | AnthropicResponse,
): response is AnthropicResponse {
  return Object.hasOwn(response, "content") && Object.hasOwn(response, "usage")
}

function recordAnthropicUsage(
  c: Context,
  accountId: string,
  response: AnthropicResponse,
): void {
  const usage = response.usage
  const model = c.get("model" as never) as string | undefined
  if (!model) {
    return
  }

  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  recordUsage(
    createUsageRecord({
      c,
      accountId,
      model,
      promptTokens: Math.max(usage.input_tokens - cacheReadTokens, 0),
      completionTokens: usage.output_tokens,
      totalTokens:
        usage.input_tokens
        + usage.output_tokens
        + cacheReadTokens
        + cacheWriteTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }),
  )
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
