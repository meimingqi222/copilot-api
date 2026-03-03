import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit, RateLimitQueueFullError } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
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

  const anthropicBeta = c.req.header("anthropic-beta")
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const openAIPayload = translateToOpenAI(anthropicPayload)
  const initiator = inferInitiatorFromAnthropicMessages(
    anthropicPayload.messages,
    anthropicBeta,
  )
  consola.debug("Inferred X-Initiator:", initiator)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  // Debug: log all tool_call ids to detect duplicates
  const allToolCallIds = openAIPayload.messages.flatMap((m) =>
    m.tool_calls ? m.tool_calls.map((tc) => tc.id) : [],
  )
  const duplicateIds = allToolCallIds.filter(
    (id, i) => allToolCallIds.indexOf(id) !== i,
  )
  if (duplicateIds.length > 0) {
    consola.error("Duplicate tool_call ids detected:", duplicateIds)
    consola.error(
      "Messages with tool_calls:",
      JSON.stringify(
        openAIPayload.messages
          .filter((m) => m.tool_calls)
          .map((m) => ({
            role: m.role,
            ids: m.tool_calls?.map((tc) => tc.id),
          })),
      ),
    )
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload, signal, initiator)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, (stream) => handleStreamingResponse(stream, response))
}

type SSEStream = Parameters<Parameters<typeof streamSSE>[1]>[0]
type CopilotStream = Exclude<
  Awaited<ReturnType<typeof createChatCompletions>>,
  ChatCompletionResponse
>

async function handleStreamingResponse(
  stream: SSEStream,
  response: CopilotStream,
): Promise<void> {
  try {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageStopSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      currentContentBlockType: undefined,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }

    // If upstream closed without finish_reason (e.g. premature disconnect),
    // send a synthetic error event so the client gets a clean termination.
    if (streamState.messageStartSent && !streamState.messageStopSent) {
      consola.warn(
        "Upstream closed stream without finish_reason, sending error event",
      )
      const errorEvent = translateErrorToAnthropicErrorEvent()
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      consola.debug("Stream aborted (client disconnected)")
      return
    }
    throw e
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
