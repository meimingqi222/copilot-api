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
  ChatCompletionChunk,
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
    // Ask the producer for its structured delta twin so the stream translator
    // below can skip re-parsing SSE JSON it just serialized (per-token win on
    // long streams; other adapters ignore the hint and stay on the JSON path).
    ctx: { ...ctx, collectChatStreamTwin: true },
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

/**
 * Structured twin of an emitted SSE chunk, attached by chat streaming
 * producers that opt in (Windsurf does when `collectChatStreamTwin` is set).
 * Mirrors the producer side (`windsurf/collect-response.ts` `CollectedDelta`
 * + `chunk-builders.ts`); `tests/messages-via-chat-twin-parity.test.ts`
 * locks the two together. A future producer reusing the `collected` field
 * name must match this shape or stay off the fast path.
 */
interface CollectedChatDelta {
  content?: string
  reasoningText?: string
  reasoningOpaque?: string
  toolCalls?: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter"
  usage?: ChatCompletionChunk["usage"]
}

/**
 * Rebuilds the chunk the producer serialized, without `JSON.parse`. `id` and
 * `model` come from the stream's first chunk (parsed once); `created` is
 * unread downstream so it stays zero.
 */
function chunkFromCollectedTwin(
  twin: CollectedChatDelta,
  id: string,
  model: string,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        delta: {
          ...(twin.content !== undefined && { content: twin.content }),
          ...(twin.reasoningText !== undefined && {
            reasoning_text: twin.reasoningText,
          }),
          ...(twin.reasoningOpaque !== undefined && {
            reasoning_opaque: twin.reasoningOpaque,
          }),
          ...(twin.toolCalls && { tool_calls: twin.toolCalls }),
        },
        finish_reason: twin.finishReason ?? null,
        logprobs: null,
      },
    ],
    ...(twin.usage && { usage: twin.usage }),
  }
}

async function* translateChatStreamToAnthropicEvents(
  chatStream: AsyncIterable<CopilotStreamEvent>,
  anthropicPayload: AnthropicMessagesPayload,
): AsyncIterable<AnthropicStreamEventData> {
  const streamState = createInitialStreamState()
  streamState.estimatedInputTokens = estimateInputTokens(anthropicPayload)
  // Upstream request id/model for message_start, captured once from the
  // first chunk. Later chunks take the twin fast path when present.
  let streamId: string | undefined
  let streamModel: string | undefined

  for await (const rawEvent of chatStream) {
    if (rawEvent.data === "[DONE]") {
      break
    }
    if (!rawEvent.data) {
      continue
    }
    const twin = (rawEvent as { collected?: CollectedChatDelta }).collected
    let chunk: ChatCompletionChunk
    if (twin && streamId !== undefined && streamModel !== undefined) {
      chunk = chunkFromCollectedTwin(twin, streamId, streamModel)
    } else {
      chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      streamId ??= chunk.id
      streamModel ??= chunk.model
    }
    const events = translateChunkToAnthropicEvents(chunk, streamState)
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
