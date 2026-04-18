import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Account } from "~/lib/accounts"

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
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage } from "~/lib/usage"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
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

type CopilotStream = AsyncIterable<{ data?: string; event?: string }>

interface HandleStreamingResponseOptions {
  stream: SSEStream
  response: CopilotStream
  clientSignal: AbortSignal
  c?: Context
  accountId: string
  estimatedInputTokens?: number
  skipPing?: boolean
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

  const anthropicBeta = c.req.header("anthropic-beta")
  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: anthropicPayload.model,
    maxTokens:
      typeof anthropicPayload.max_tokens === "number" ?
        anthropicPayload.max_tokens
      : undefined,
    stream: anthropicPayload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromAnthropicMessages(
      anthropicPayload.messages,
      anthropicBeta,
    ),
  })

  const anthropicVersion = c.req.header("anthropic-version")
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

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
    account: admission.account,
    initiator: admission.initiator,
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
    const result = await createMessages(anthropicPayload, {
      account,
      signal,
      initiatorOverride: initiator,
      forwardedHeaders: { anthropicBeta, anthropicVersion },
    })

    c.set("accountId" as never, result.accountId)
    c.set("model" as never, anthropicPayload.model)

    if (isDirectAnthropicResponse(result.response)) {
      recordAnthropicUsage(c, result.accountId, result.response)
      return c.json(result.response)
    }
  }

  return streamSSE(c, async (stream) => {
    const pingInterval = createSsePingInterval(stream)
    try {
      const result = await createMessages(anthropicPayload, {
        account,
        signal,
        initiatorOverride: initiator,
        forwardedHeaders: { anthropicBeta, anthropicVersion },
      })

      c.set("accountId" as never, result.accountId)
      c.set("model" as never, anthropicPayload.model)

      if (isDirectAnthropicResponse(result.response)) {
        recordAnthropicUsage(c, result.accountId, result.response)
        return
      }

      await handleDirectStreamingResponse({
        stream,
        response: result.response,
        clientSignal: signal,
        c,
        accountId: result.accountId,
        skipPing: true,
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

interface HandleCopilotApiOpts {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  signal: AbortSignal
  account: Account
  initiator: "agent" | "user" | undefined
}

async function handleCopilotApi(opts: HandleCopilotApiOpts) {
  const { c, anthropicPayload, signal, account, initiator } = opts
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
    let result
    try {
      result = await createChatCompletions(openAIPayload, {
        signal,
        initiatorOverride: initiator,
        account,
      })
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
      return c.json(
        handleNonStreamingResponse(c, result.accountId, result.response),
      )
    }
  }

  return streamSSE(c, async (stream) => {
    const pingInterval = createSsePingInterval(stream)
    try {
      let result
      try {
        result = await createChatCompletions(openAIPayload, {
          signal,
          initiatorOverride: initiator,
          account,
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
        handleNonStreamingResponse(c, result.accountId, result.response)
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
}: HandleStreamingResponseOptions): Promise<void> {
  const streamState = createInitialStreamState()
  streamState.estimatedInputTokens = estimatedInputTokens
  let lastUsage: UsageInfo | undefined

  const pingInterval = skipPing ? undefined : createSsePingInterval(stream)

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
  skipPing = false,
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

  try {
    for await (const rawEvent of response) {
      if (!rawEvent.data || rawEvent.data === "[DONE]") {
        continue
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
      recordDirectStreamingUsage(c, accountId, lastUsage)
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
  })
}
