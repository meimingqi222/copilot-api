/* eslint-disable max-lines */
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Account } from "~/lib/accounts"
import type { RequestAdmission } from "~/lib/request-admission"

import { HTTPError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import {
  createSsePingInterval,
  forwardSseEvent,
  type SSEStream,
  writeSseEvent,
} from "~/lib/sse"
import { state } from "~/lib/state"
import { computeStreamingTiming } from "~/lib/timing"
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage } from "~/lib/usage"
import { isChatCompletionResponse } from "~/lib/utils"
import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  supportsMessagesApi,
  type CopilotStreamEventLike,
} from "~/services/copilot/responses-api"
import { dispatchChatCompletions } from "~/services/dispatch/chat-completions"
import { dispatchMessages } from "~/services/dispatch/messages"

import {
  createInitialStreamState,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamState,
  extractMessageContentFromAnthropicPayload,
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

type CopilotStream = AsyncIterable<{ data?: string; event?: string }>

interface HandleStreamingResponseOptions {
  stream: SSEStream
  response: CopilotStream
  clientSignal: AbortSignal
  c?: Context
  accountId: string
  estimatedInputTokens?: number
  skipPing?: boolean
  streamStartTs?: number
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

export async function handleCompletion(c: Context) {
  const signal = c.req.raw.signal
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const messageContent =
    extractMessageContentFromAnthropicPayload(anthropicPayload)

  const anthropicBeta = c.req.header("anthropic-beta")
  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: anthropicPayload.model,
    endpoint: "messages",
    maxTokens:
      typeof anthropicPayload.max_tokens === "number" ?
        anthropicPayload.max_tokens
      : undefined,
    stream: anthropicPayload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromAnthropicMessages(
      anthropicPayload.messages,
      anthropicBeta,
    ),
    messageContent,
  })

  const anthropicVersion = c.req.header("anthropic-version")
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Provider Connection 路径
  if (admission.kind === "connection") {
    if (admission.connection.protocol === "anthropic-compatible") {
      return handleAnthropicViaConnection({
        c,
        anthropicPayload,
        signal,
        admission,
        anthropicBeta,
        anthropicVersion,
      })
    }
    // openai-compatible 或其它:走 Anthropic -> OpenAI 翻译链路,
    // 然后通过 dispatcher 调用对应 adapter。
    return handleCopilotApi({
      c,
      anthropicPayload,
      signal,
      admission,
    })
  }

  if (
    supportsMessagesApi(anthropicPayload.model, admission.account)
    && admission.account.provider === "copilot"
  ) {
    return handleMessagesApi({
      c,
      anthropicPayload,
      signal,
      account: admission.account,
      initiator: admission.initiator,
      anthropicBeta,
      anthropicVersion,
    })
  }

  return handleCopilotApi({
    c,
    anthropicPayload,
    signal,
    admission,
  })
}

interface HandleMessagesApiOpts {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  signal: AbortSignal
  account: Account
  initiator: "agent" | "user" | undefined
  anthropicBeta: string | undefined
  anthropicVersion: string | undefined
}

async function handleMessagesApi(opts: HandleMessagesApiOpts) {
  const {
    c,
    anthropicPayload,
    signal,
    account,
    initiator,
    anthropicBeta,
    anthropicVersion,
  } = opts
  if (!anthropicPayload.stream) {
    const nonStreamStart = Date.now()
    const result = await createMessages(anthropicPayload, {
      account,
      signal,
      initiatorOverride: initiator,
      forwardedHeaders: { anthropicBeta, anthropicVersion },
      c,
    })

    c.set("accountId" as never, result.accountId)
    c.set("model" as never, anthropicPayload.model)

    if (isDirectAnthropicResponse(result.response)) {
      const elapsed = Date.now() - nonStreamStart
      const tps =
        elapsed > 0 ? result.response.usage.output_tokens / (elapsed / 1000) : 0
      recordAnthropicUsage(c, result.accountId, result.response, tps)
      return c.json(result.response)
    }
  }

  return streamSSE(c, async (stream) => {
    const pingInterval = createSsePingInterval(stream)
    const streamStartTs = Date.now()
    try {
      const result = await createMessages(anthropicPayload, {
        account,
        signal,
        initiatorOverride: initiator,
        forwardedHeaders: { anthropicBeta, anthropicVersion },
        c,
      })

      c.set("accountId" as never, result.accountId)
      c.set("model" as never, anthropicPayload.model)

      if (isDirectAnthropicResponse(result.response)) {
        const elapsed = Date.now() - streamStartTs
        const tps =
          elapsed > 0 ?
            result.response.usage.output_tokens / (elapsed / 1000)
          : 0
        recordAnthropicUsage(c, result.accountId, result.response, tps)
        return
      }

      await handleDirectStreamingResponse({
        stream,
        response: result.response,
        clientSignal: signal,
        c,
        accountId: result.accountId,
        skipPing: true,
        streamStartTs,
      })
    } catch (error) {
      const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
      if (knownError) {
        const errPayload = {
          type: "error",
          error: {
            type: knownError.type,
            message: knownError.message,
          },
        }
        await writeSseEvent(stream, JSON.stringify(errPayload), errPayload.type)
        return
      }
      if (error instanceof HTTPError) {
        consola.error(
          "Messages API upstream error",
          error.response.status,
          error.responseBody,
        )
        const errPayload = buildAnthropicUpstreamError(error)
        await writeSseEvent(stream, JSON.stringify(errPayload), errPayload.type)
        return
      }
      throw error
    } finally {
      clearInterval(pingInterval)
    }
  })
}

interface HandleAnthropicViaConnectionOpts {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  signal: AbortSignal
  admission: Extract<RequestAdmission, { kind: "connection" }>
  anthropicBeta: string | undefined
  anthropicVersion: string | undefined
}

async function handleAnthropicViaConnection(
  opts: HandleAnthropicViaConnectionOpts,
) {
  const {
    c,
    anthropicPayload,
    signal,
    admission,
    anthropicBeta,
    anthropicVersion,
  } = opts
  const forwarded: Record<string, string | undefined> = {
    "anthropic-beta": anthropicBeta,
    "anthropic-version": anthropicVersion,
  }

  if (!anthropicPayload.stream) {
    const nonStreamStart = Date.now()
    const result = await dispatchMessages(
      anthropicPayload as unknown as Record<string, unknown> & {
        model: string
        stream?: boolean
      },
      admission,
      signal,
      forwarded,
    )
    c.set("accountId" as never, result.accountId)
    c.set("model" as never, anthropicPayload.model)
    if (!isAsyncIterable(result.response)) {
      if (
        isDirectAnthropicResponse(
          result.response as unknown as AnthropicResponse,
        )
      ) {
        const elapsed = Date.now() - nonStreamStart
        const response = result.response as unknown as AnthropicResponse
        const tps =
          elapsed > 0 ? response.usage.output_tokens / (elapsed / 1000) : 0
        recordAnthropicUsage(c, result.accountId, response, tps)
      }
      return c.json(result.response as unknown as AnthropicResponse)
    }
  }

  return streamSSE(c, async (stream) => {
    const pingInterval = createSsePingInterval(stream)
    let lastUsage:
      | {
          input_tokens?: number
          output_tokens: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      | undefined
    let resultAccountId: string | undefined
    let firstChunkTs: number | undefined
    let streamStart = 0
    try {
      streamStart = Date.now()
      const result = await dispatchMessages(
        anthropicPayload as unknown as Record<string, unknown> & {
          model: string
          stream?: boolean
        },
        admission,
        signal,
        forwarded,
      )
      resultAccountId = result.accountId
      c.set("accountId" as never, result.accountId)
      c.set("model" as never, anthropicPayload.model)
      if (!isAsyncIterable(result.response)) {
        if (
          isDirectAnthropicResponse(
            result.response as unknown as AnthropicResponse,
          )
        ) {
          const elapsed = Date.now() - streamStart
          const response = result.response as unknown as AnthropicResponse
          const tps =
            elapsed > 0 ? response.usage.output_tokens / (elapsed / 1000) : 0
          recordAnthropicUsage(c, result.accountId, response, tps)
        }
        await writeSseEvent(stream, JSON.stringify(result.response))
        return
      }
      for await (const event of result.response as AsyncIterable<{
        data?: string
        event?: string
      }>) {
        if (!event.data) continue
        if (!firstChunkTs) {
          firstChunkTs = Date.now()
        }
        lastUsage = updateLastUsage(event.data, lastUsage)
        await forwardSseEvent(stream, event)
      }
    } catch (error) {
      const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
      if (knownError) {
        await writeSseEvent(
          stream,
          JSON.stringify({
            type: "error",
            error: { type: knownError.type, message: knownError.message },
          }),
          "error",
        )
        return
      }
      throw error
    } finally {
      clearInterval(pingInterval)
      if (resultAccountId) {
        recordDirectStreamingUsage(
          c,
          resultAccountId,
          lastUsage,
          computeStreamingTiming(
            streamStart,
            firstChunkTs,
            lastUsage?.output_tokens ?? 0,
          ),
        )
      }
    }
  })
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  )
}

interface HandleCopilotApiOpts {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  signal: AbortSignal
  admission: RequestAdmission
}

async function handleCopilotApi(opts: HandleCopilotApiOpts) {
  const { c, anthropicPayload, signal, admission } = opts
  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  logDuplicateToolCallIds(openAIPayload.messages)

  // Pre-calculate input token count so message_start can carry a meaningful
  // input_tokens value even for models (e.g. gpt-5.3-codex via Responses API)
  // where upstream usage data only arrives in the final streaming chunk.
  const estimatedInputTokens = await estimateInputTokens(openAIPayload)

  if (!anthropicPayload.stream) {
    const nonStreamStart = Date.now()
    let result
    try {
      result = await dispatchChatCompletions(
        openAIPayload,
        admission,
        signal,
        c,
      )
    } catch (error) {
      if (error instanceof HTTPError && isContextWindowError(error)) {
        consola.warn(
          "Context window exceeded (estimated input tokens: %d)",
          estimatedInputTokens,
        )
        return c.json(buildAnthropicContextWindowError(error), 400)
      }
      throw error
    }

    c.set("accountId" as never, result.accountId)
    c.set("model" as never, openAIPayload.model)

    if (isNonStreaming(result)) {
      const elapsed = Date.now() - nonStreamStart
      return c.json(
        handleNonStreamingResponse(
          c,
          result.accountId,
          result.response,
          elapsed,
        ),
      )
    }
  }

  return streamSSE(c, async (stream) => {
    const pingInterval = createSsePingInterval(stream)
    const streamStartTs = Date.now()
    try {
      let result
      try {
        result = await dispatchChatCompletions(
          openAIPayload,
          admission,
          signal,
          c,
        )
      } catch (error) {
        const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
        if (knownError) {
          const errPayload = {
            type: "error",
            error: {
              type: knownError.type,
              message: knownError.message,
            },
          }
          await writeSseEvent(stream, JSON.stringify(errPayload), "error")
          return
        }
        if (error instanceof HTTPError && isContextWindowError(error)) {
          consola.warn(
            "Context window exceeded (estimated input tokens: %d)",
            estimatedInputTokens,
          )
          const errPayload = buildAnthropicContextWindowError(error)
          await writeSseEvent(stream, JSON.stringify(errPayload), "error")
          return
        }
        throw error
      }

      c.set("accountId" as never, result.accountId)
      c.set("model" as never, openAIPayload.model)

      if (isNonStreaming(result)) {
        const elapsed = Date.now() - streamStartTs
        handleNonStreamingResponse(
          c,
          result.accountId,
          result.response,
          elapsed,
        )
        return
      }

      await handleStreamingResponse({
        stream,
        response: result.response,
        clientSignal: signal,
        c,
        accountId: result.accountId,
        estimatedInputTokens,
        skipPing: true,
        streamStartTs,
      })
    } finally {
      clearInterval(pingInterval)
    }
  })
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
  elapsedMs?: number,
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
    const tps =
      elapsedMs && elapsedMs > 0 ?
        usage.output_tokens / (elapsedMs / 1000)
      : undefined
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

  return anthropicResponse
}

async function handleStreamingResponse({
  stream,
  response,
  clientSignal,
  c,
  accountId,
  estimatedInputTokens = 0,
  skipPing = false,
  streamStartTs,
}: HandleStreamingResponseOptions): Promise<void> {
  const streamState = createInitialStreamState()
  streamState.estimatedInputTokens = estimatedInputTokens
  let lastUsage: UsageInfo | undefined
  let firstChunkTs: number | undefined
  const streamStart = streamStartTs ?? Date.now()

  const pingInterval = skipPing ? undefined : createSsePingInterval(stream)

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
      recordStreamingUsage(
        c,
        accountId,
        lastUsage,
        computeStreamingTiming(
          streamStart,
          firstChunkTs,
          lastUsage?.completion_tokens ?? 0,
        ),
      )
    }
  }
}

async function handleDirectStreamingResponse({
  stream,
  response,
  clientSignal,
  c,
  accountId,
  skipPing = false,
  streamStartTs,
}: HandleStreamingResponseOptions): Promise<void> {
  let lastUsage:
    | {
        input_tokens?: number
        output_tokens: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    | undefined

  const pingInterval = skipPing ? undefined : createSsePingInterval(stream)

  let receivedMessageStop = false
  let firstChunkTs: number | undefined
  const streamStart = streamStartTs ?? Date.now()

  try {
    for await (const rawEvent of response) {
      if (!rawEvent.data || rawEvent.data === "[DONE]") {
        continue
      }

      if (!firstChunkTs) {
        firstChunkTs = Date.now()
      }

      lastUsage = updateLastUsage(rawEvent.data, lastUsage)

      try {
        const parsed = JSON.parse(rawEvent.data) as { type?: string }
        if (parsed.type === "message_stop") {
          receivedMessageStop = true
        }
      } catch {
        // ignore parse errors for tracking purposes
      }

      await forwardSseEvent(stream, rawEvent)
    }

    if (!receivedMessageStop) {
      consola.warn(
        "Direct streaming: upstream closed without message_stop, sending synthetic error",
      )
      const errPayload = {
        type: "error",
        error: {
          type: "api_error",
          message:
            "Upstream closed the stream unexpectedly. The model may not support images in tool results for this endpoint.",
        },
      }
      await writeSseEvent(stream, JSON.stringify(errPayload), errPayload.type)
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
      recordDirectStreamingUsage(
        c,
        accountId,
        lastUsage,
        computeStreamingTiming(
          streamStart,
          firstChunkTs,
          lastUsage?.output_tokens ?? 0,
        ),
      )
    }
  }
}

function updateLastUsage(
  eventData: string,
  lastUsage:
    | {
        input_tokens?: number
        output_tokens: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    | undefined,
):
  | {
      input_tokens?: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  | undefined {
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

async function writeAnthropicEvents(
  stream: SSEStream,
  events: Array<ReturnType<typeof translateChunkToAnthropicEvents>[number]>,
): Promise<void> {
  for (const event of events) {
    consola.debug("Translated Anthropic event:", JSON.stringify(event))
    await writeSseEvent(stream, JSON.stringify(event), event.type)
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
  timing?: { ttftMs: number; tps: number },
): void {
  const model = c.get("model" as never) as string | undefined
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
  timing?: { ttftMs: number; tps: number },
): void {
  const model = c.get("model" as never) as string | undefined
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
  await writeSseEvent(stream, JSON.stringify(errorEvent), errorEvent.type)
  return true
}

/** Estimate request input token count using the local tokenizer as a fallback. */
async function estimateInputTokens(
  payload: ChatCompletionsPayload,
): Promise<number> {
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  if (!selectedModel) {
    return 0
  }
  try {
    const tokenCount = await getTokenCount(payload, selectedModel)
    return tokenCount.input
  } catch {
    return 0
  }
}

/** Returns true when the upstream error indicates the input exceeded the model context window. */
function isContextWindowError(error: HTTPError): boolean {
  return (
    error.response.status === 400
    && error.responseBody.toLowerCase().includes("context window")
  )
}

/** Build a proper Anthropic-format error response for context-window violations. */
function buildAnthropicContextWindowError(error: HTTPError): {
  type: string
  error: { type: string; message: string }
} {
  const defaultMessage =
    "Your input exceeds the context window of this model. Please adjust your input and try again."
  let message = defaultMessage
  try {
    const parsed = JSON.parse(error.responseBody) as {
      error?: { message?: string }
    }
    if (parsed.error?.message) {
      message = parsed.error.message
    }
    // Unwrap double-encoded JSON (upstream sometimes wraps it twice)
    if (message.startsWith("{")) {
      const inner = JSON.parse(message) as { error?: { message?: string } }
      message = inner.error?.message || defaultMessage
    }
  } catch {
    // Keep default message
  }
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message,
    },
  }
}

/** Build a generic Anthropic-format error response from any upstream HTTPError. */
function buildAnthropicUpstreamError(error: HTTPError): {
  type: string
  error: { type: string; message: string }
} {
  let message = `Upstream API error (${error.response.status}): ${error.message}`
  try {
    const parsed = JSON.parse(error.responseBody) as {
      error?: { message?: string }
      message?: string
    }
    const raw = parsed.error?.message ?? parsed.message
    if (raw) {
      message =
        raw.startsWith("{") ?
          ((JSON.parse(raw) as { error?: { message?: string } }).error?.message
          ?? raw)
        : raw
    }
  } catch {
    // Keep default message
  }
  return {
    type: "error",
    error: {
      type: "api_error",
      message,
    },
  }
}

const isNonStreaming = (
  result:
    | { accountId: string; response: CopilotStream }
    | { accountId: string; response: ChatCompletionResponse },
): result is { accountId: string; response: ChatCompletionResponse } =>
  isChatCompletionResponse(result.response as object)

function isDirectAnthropicResponse(
  response: AsyncIterable<CopilotStreamEventLike> | AnthropicResponse,
): response is AnthropicResponse {
  return Object.hasOwn(response, "content") && Object.hasOwn(response, "usage")
}

function recordAnthropicUsage(
  c: Context,
  accountId: string,
  response: AnthropicResponse,
  tps?: number,
): void {
  const usage = response.usage
  const model = c.get("model" as never) as string | undefined
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
