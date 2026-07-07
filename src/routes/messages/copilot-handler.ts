import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"

import { HTTPError } from "~/lib/error"
import { buildAnthropicContextWindowError } from "~/lib/error-builder"
import { logger } from "~/lib/logger"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import {
  handleSseStream,
  type SSEStream,
  writeSseEvent,
  writeSseEvents,
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
import { dispatchChatCompletions } from "~/services/dispatch/chat-completions"

import {
  createInitialStreamState,
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
  type CopilotStream,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
  translateStreamEndEvents,
} from "./stream-translation"
import { recordStreamingUsage, type UsageInfo } from "./usage-recorder"

export interface HandleStreamingResponseOptions {
  stream: SSEStream
  response: CopilotStream
  clientSignal: AbortSignal
  c?: Context
  accountId: string
  estimatedInputTokens?: number
  skipPing?: boolean
  streamStartTs?: number
}

interface HandleCopilotApiOpts {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  signal: AbortSignal
  admission: RequestAdmission
}

export async function handleCopilotApi(opts: HandleCopilotApiOpts) {
  const { c, anthropicPayload, signal, admission } = opts
  const openAIPayload = translateToOpenAI(anthropicPayload)
  if (logger.level >= 4) {
    logger.debug(
      "Translated OpenAI request payload:",
      JSON.stringify(openAIPayload),
    )
  }

  logDuplicateToolCallIds(openAIPayload.messages)

  if (!anthropicPayload.stream) {
    const estimatedInputTokens = await estimateInputTokens(openAIPayload)
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
        logger.warn(
          "Context window exceeded (estimated input tokens: %d)",
          estimatedInputTokens,
        )
        return c.json(buildAnthropicContextWindowError(error), 400)
      }
      throw error
    }

    c.set("accountId", result.accountId)
    c.set("model", openAIPayload.model)

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

  const estimatedInputTokens = await estimateInputTokens(openAIPayload)

  return handleSseStream(c, async (stream, sseSignal) => {
    const streamStartTs = Date.now()
    let result
    try {
      result = await dispatchChatCompletions(
        openAIPayload,
        admission,
        sseSignal,
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
        logger.warn("Context window exceeded")
        const errPayload = buildAnthropicContextWindowError(error)
        await writeSseEvent(stream, JSON.stringify(errPayload), "error")
        return
      }
      throw error
    }

    c.set("accountId", result.accountId)
    c.set("model", openAIPayload.model)

    if (isNonStreaming(result)) {
      const elapsed = Date.now() - streamStartTs
      handleNonStreamingResponse(c, result.accountId, result.response, elapsed)
      return
    }

    await handleStreamingResponse({
      stream,
      response: result.response,
      clientSignal: sseSignal,
      c,
      accountId: result.accountId,
      estimatedInputTokens,
      skipPing: true,
      streamStartTs,
    })
  })
}

function logDuplicateToolCallIds(
  messages: Array<{ role: string; tool_calls?: Array<{ id: string }> }>,
): void {
  const seen = new Set<string>()
  const duplicateIds = new Set<string>()

  for (const message of messages) {
    if (!message.tool_calls) {
      continue
    }
    for (const toolCall of message.tool_calls) {
      if (seen.has(toolCall.id)) {
        duplicateIds.add(toolCall.id)
      } else {
        seen.add(toolCall.id)
      }
    }
  }

  if (duplicateIds.size === 0) {
    return
  }

  logger.error("Duplicate tool_call ids detected:", [...duplicateIds])
  logger.error(
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
  if (logger.level >= 4) {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
  }
  const anthropicResponse = translateToAnthropic(response)
  if (logger.level >= 4) {
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
  }

  const usage = anthropicResponse.usage
  const model = c.get("model")

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
  streamStartTs,
}: HandleStreamingResponseOptions): Promise<void> {
  const streamState = createInitialStreamState()
  streamState.estimatedInputTokens = estimatedInputTokens
  let lastUsage: UsageInfo | undefined
  let firstChunkTs: number | undefined
  const streamStart = streamStartTs ?? Date.now()

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
      if (logger.level >= 4) {
        logger.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      }
      lastUsage = chunk.usage ?? lastUsage
      const translatedEvents = translateChunkToAnthropicEvents(
        chunk,
        streamState,
      )
      if (logger.level >= 4) {
        for (const event of translatedEvents) {
          logger.debug("Translated Anthropic event:", JSON.stringify(event))
        }
      }
      await writeSseEvents(
        stream,
        translatedEvents.map((event) => ({
          data: JSON.stringify(event),
          event: event.type,
        })),
      )
    }

    const endEvents = translateStreamEndEvents(streamState)
    if (endEvents.length > 0) {
      await writeSseEvents(
        stream,
        endEvents.map((event) => ({
          data: JSON.stringify(event),
          event: event.type,
        })),
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

async function handleStreamingError(input: {
  error: unknown
  clientSignal: AbortSignal
  stream: SSEStream
  streamState: AnthropicStreamState
}): Promise<boolean> {
  const { error, clientSignal, stream, streamState } = input
  if (error instanceof DOMException && error.name === "AbortError") {
    if (clientSignal.aborted) {
      logger.debug("Stream aborted (client disconnected)")
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

    logger.warn("Stream aborted unexpectedly before first response event")
    return true
  }

  const sent = await sendSyntheticErrorIfNeeded(
    stream,
    streamState,
    "Unexpected streaming error",
  )
  return sent
}

async function sendSyntheticErrorIfNeeded(
  stream: SSEStream,
  streamState: AnthropicStreamState,
  reason: string,
): Promise<boolean> {
  if (!streamState.messageStartSent || streamState.messageStopSent) {
    return false
  }

  logger.warn(`${reason}, sending error event`)
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

const isNonStreaming = (
  result:
    | { accountId: string; response: CopilotStream }
    | { accountId: string; response: ChatCompletionResponse },
): result is { accountId: string; response: ChatCompletionResponse } =>
  isChatCompletionResponse(result.response as object)
