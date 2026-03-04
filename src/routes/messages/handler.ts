import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { checkRateLimit, RateLimitQueueFullError } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { incrementUserTokens } from "~/lib/users"
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
  const inferredInitiator = inferInitiatorFromAnthropicMessages(
    anthropicPayload.messages,
    anthropicBeta,
  )
  // 仅对具备管理权限的已认证调用方信任 x-initiator=agent
  const { clientInitiator, initiator, trustedClientAgent } =
    resolveInitiatorWithClientHeader(c, inferredInitiator)
  consola.debug(
    "X-Initiator: client=%s inferred=%s trusted_agent=%s final=%s",
    clientInitiator ?? "(none)",
    inferredInitiator,
    trustedClientAgent,
    initiator,
  )
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
    // Track token usage for non-streaming response
    const usage = anthropicResponse.usage
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (usage) {
      const totalTokens = usage.input_tokens + usage.output_tokens
      void trackTokenUsage(c, totalTokens)
    }
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, (stream) =>
    handleStreamingResponse({ stream, response, clientSignal: signal, c }),
  )
}

type SSEStream = Parameters<Parameters<typeof streamSSE>[1]>[0]
type CopilotStream = Exclude<
  Awaited<ReturnType<typeof createChatCompletions>>,
  ChatCompletionResponse
>

interface HandleStreamingResponseOptions {
  stream: SSEStream
  response: CopilotStream
  clientSignal: AbortSignal
  c?: Context
}

async function handleStreamingResponse({
  stream,
  response,
  clientSignal,
  c,
}: HandleStreamingResponseOptions): Promise<void> {
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    messageStopSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    currentContentBlockType: undefined,
    toolCalls: {},
  }
  let lastUsage:
    | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    | undefined

  // Send periodic ping events to keep the SSE connection alive.
  // Without these, idle periods (e.g. while Copilot generates long tool_call
  // arguments) can cause the client's HTTP stream to terminate with a TypeError.
  const PING_INTERVAL_MS = 5_000
  const pingInterval = setInterval(async () => {
    try {
      await stream.writeSSE({ event: "ping", data: '{"type": "ping"}' })
    } catch {
      // Stream already closed; clear interval in finally below.
    }
  }, PING_INTERVAL_MS)

  try {
    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      // Capture usage from chunk if available
      if (chunk.usage) {
        lastUsage = chunk.usage
      }
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
    await sendSyntheticErrorIfNeeded(
      stream,
      streamState,
      "Upstream closed stream without finish_reason",
    )
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      if (clientSignal.aborted) {
        consola.debug("Stream aborted (client disconnected)")
        return
      }

      const sent = await sendSyntheticErrorIfNeeded(
        stream,
        streamState,
        "Upstream aborted stream before finish_reason",
      )
      if (sent) {
        return
      }
      consola.warn("Stream aborted unexpectedly before first response event")
      return
    }

    const sent = await sendSyntheticErrorIfNeeded(
      stream,
      streamState,
      "Unexpected streaming error",
    )
    if (sent) {
      return
    }
    throw e
  } finally {
    clearInterval(pingInterval)
    // Track token usage after streaming completes
    if (c && lastUsage) {
      void trackTokenUsage(
        c,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        lastUsage.total_tokens
          ?? lastUsage.prompt_tokens + lastUsage.completion_tokens,
      )
    }
  }
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
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

/**
 * Track token usage for the authenticated user
 */
async function trackTokenUsage(c: Context, tokens: number): Promise<void> {
  if (tokens <= 0) return
  const userId = c.get("userId" as never) as string | undefined
  if (!userId) return
  try {
    await incrementUserTokens(userId, tokens)
    consola.debug(`Tracked ${tokens} tokens for user ${userId}`)
  } catch (error) {
    consola.warn("Failed to track token usage:", error)
  }
}
