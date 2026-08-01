/**
 * Shared helper for serving Anthropic Messages requests via a Chat Completions
 * upstream. Mirrors `chat-via-responses.ts`: converts an Anthropic Messages
 * payload -> Chat Completions payload, delegates to the adapter's
 * `createChatCompletions`, then converts the Chat result back to Anthropic
 * format (streaming or non-streaming).
 *
 * Used by the dispatch layer when a `/v1/messages` request fails over to a
 * target whose adapter only implements `createChatCompletions` (e.g. an
 * openai-compatible connection), so cross-protocol fallback is transparent.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import type { AdapterChatResult, AdapterMessagesResult } from "./types"

import {
  createInitialStreamState,
  translateChunkToAnthropicEvents,
  translateStreamEndEvents,
  translateToAnthropic,
  translateToOpenAI,
  type AnthropicMessagesPayload,
  type AnthropicStreamEventData,
} from "./anthropic"

interface ChatExecutorParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}

type ChatExecutor = (params: ChatExecutorParams) => Promise<AdapterChatResult>

interface MessagesViaChatParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: AnthropicMessagesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  chatExecutor: ChatExecutor
}

/** A non-streaming ChatCompletionResponse is a plain object; a stream has asyncIterator. */
function isChatCompletionResponse(
  value: unknown,
): value is ChatCompletionResponse {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(Symbol.asyncIterator in value)
  )
}

export async function createMessagesViaChat(
  params: MessagesViaChatParams,
): Promise<AdapterMessagesResult> {
  const { target, connection, credential, payload, signal, ctx, chatExecutor } =
    params

  // Preserve historical thinking for non-Copilot upstreams: DeepSeek thinking
  // mode + tool calls REQUIRES reasoning_content round-trip (else 400), and
  // Kimi/Qwen/xAI accept it. copilot-native rejects reasoning in history,
  // but it never reaches this path (it implements createMessages natively) —
  // the guard keeps the behavior explicit and future-proof.
  const openAIPayload = translateToOpenAI(payload, {
    preserveHistoricalReasoning: target.protocol !== "copilot-native",
  })
  const result = await chatExecutor({
    target,
    connection,
    credential,
    payload: openAIPayload,
    signal,
    ctx,
  })

  if (isChatCompletionResponse(result.response)) {
    const anthropicResponse = translateToAnthropic(result.response)
    return {
      credentialId: result.credentialId,
      response: anthropicResponse as unknown as Record<string, unknown>,
    }
  }

  // Streaming: translate each CopilotStreamEvent chunk into Anthropic SSE
  // events, yielding them as an AsyncIterable<AnthropicStreamEventData>.
  const anthropicStream = translateChatStreamToAnthropicEvents(
    result.response,
    payload,
  )
  return { credentialId: result.credentialId, response: anthropicStream }
}

async function* translateChatStreamToAnthropicEvents(
  chatStream: AsyncIterable<CopilotStreamEvent>,
  anthropicPayload: AnthropicMessagesPayload,
): AsyncIterable<AnthropicStreamEventData> {
  const streamState = createInitialStreamState()
  streamState.estimatedInputTokens = estimateInputTokens(anthropicPayload)

  for await (const rawEvent of chatStream) {
    if (rawEvent.data === "[DONE]") {
      break
    }
    if (!rawEvent.data) {
      continue
    }
    const chunk = JSON.parse(rawEvent.data) as {
      choices?: Array<unknown>
      usage?: unknown
    }
    if (chunk.usage) {
      streamState.lastSeenUsage = chunk.usage as NonNullable<
        (typeof streamState)["lastSeenUsage"]
      >
    }
    const events = translateChunkToAnthropicEvents(
      chunk as Parameters<typeof translateChunkToAnthropicEvents>[0],
      streamState,
    )
    for (const event of events) {
      yield event
    }
  }

  for (const event of translateStreamEndEvents(streamState)) {
    yield event
  }
}

/** Rough input-token estimate for message_start fallback (char/4 heuristic). */
function estimateInputTokens(payload: AnthropicMessagesPayload): number {
  let chars = 0
  if (payload.system) {
    if (typeof payload.system === "string") {
      chars += payload.system.length
    } else {
      for (const block of payload.system) chars += block.text.length
    }
  }
  for (const msg of payload.messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block) chars += block.text.length
      }
    }
  }
  return Math.ceil(chars / 4)
}
