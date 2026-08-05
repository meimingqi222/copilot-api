/**
 * Anthropic Messages response → OpenAI Chat Completions response translation.
 *
 * Non-streaming: converts an `AnthropicResponse` into a `ChatCompletionResponse`.
 * Streaming: consumes the Anthropic `/v1/messages` SSE event stream and emits
 * OpenAI `chat.completion.chunk` frames (`{ data?: string }`, ending with
 * `[DONE]`).
 */

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  CopilotStreamEvent,
  ContentPart,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { AnthropicResponse } from "~/services/protocols/anthropic"

import { sanitizeId } from "~/lib/id-sanitizer"
import {
  anthropicUsageToOpenAI,
  type AnthropicUsageLike,
} from "~/lib/usage-translation"

import type {
  AnthropicStreamEventLike,
  ChatViaMessagesStreamState,
} from "./types"

import { createChatViaMessagesStreamState } from "./types"

type OpenAIStopReason = ChatCompletionChunk["choices"][number]["finish_reason"]
type OpenAIUsage = NonNullable<ChatCompletionResponse["usage"]>

/**
 * Anthropic stop_reason → OpenAI finish_reason. Many-to-one and lossy:
 * `end_turn`/`stop_sequence`/`pause_turn` all collapse to `"stop"`, and
 * `refusal` has no exact OpenAI equivalent (mapped to `"stop"` — the refusal
 * text itself is preserved in content). Not reversible.
 */
export function mapAnthropicStopReasonToOpenAI(
  stopReason: AnthropicResponse["stop_reason"],
): OpenAIStopReason {
  switch (stopReason) {
    case "max_tokens": {
      return "length"
    }
    case "tool_use": {
      return "tool_calls"
    }
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case "refusal":
    case null: {
      return "stop"
    }
    default: {
      return "stop"
    }
  }
}

// Non-streaming

export function translateAnthropicResponseToChat(
  response: AnthropicResponse,
): ChatCompletionResponse {
  const reasoningParts: Array<{
    text: string
    signature?: string
  }> = []
  const textParts: Array<string> = []
  const orderedParts: Array<ContentPart> = []
  let hasReasoningAfterText = false
  const toolCalls: Array<ToolCall> = []

  for (const block of response.content) {
    switch (block.type) {
      case "text": {
        textParts.push(block.text)
        orderedParts.push({ type: "text", text: block.text })
        break
      }
      case "thinking": {
        reasoningParts.push({
          text: block.thinking,
          ...(block.signature && { signature: block.signature }),
        })
        if (textParts.length > 0) hasReasoningAfterText = true
        orderedParts.push({
          type: "reasoning",
          text: block.thinking,
          ...(block.signature && { signature: block.signature }),
        })
        break
      }
      case "tool_use": {
        toolCalls.push({
          id: sanitizeId(block.id),
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        })
        break
      }
      default: {
        // AnthropicAssistantContentBlock union is exhaustive; unreachable.
        break
      }
    }
  }

  const message: ChatCompletionResponse["choices"][number]["message"] = {
    role: "assistant",
    content:
      hasReasoningAfterText && orderedParts.length > 0 ?
        orderedParts
      : textParts.join("") || null,
    ...(reasoningParts.length > 0 && {
      reasoning_content: reasoningParts.map((part) => part.text).join(""),
      reasoning_text: reasoningParts.map((part) => part.text).join(""),
      reasoning_details: reasoningParts.map((part) => ({
        type: "reasoning.text",
        text: part.text,
        ...(part.signature && { signature: part.signature }),
      })),
    }),
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  }

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        // null stop_reason is not valid on non-streaming responses → "stop".
        finish_reason:
          mapAnthropicStopReasonToOpenAI(response.stop_reason) ?? "stop",
      },
    ],
    // AnthropicResponse.usage is always present.
    usage: toOpenAIUsage(response.usage),
  }
}

// Streaming

export async function* translateAnthropicStreamToChatEvents(
  stream: AsyncIterable<unknown>,
): AsyncIterable<CopilotStreamEvent> {
  const state = createChatViaMessagesStreamState()

  for await (const rawEvent of stream) {
    const data = (rawEvent as { data?: string }).data
    if (!data || data === "[DONE]") continue

    let event: AnthropicStreamEventLike
    try {
      event = JSON.parse(data) as AnthropicStreamEventLike
    } catch {
      continue
    }
    if (event.type === "ping") continue

    const chunks = translateAnthropicEventToChatChunks(event, state)
    for (const chunk of chunks) {
      yield { data: JSON.stringify(chunk) }
    }
  }

  // Upstream closed without message_delta/message_stop — emit a terminal chunk.
  if (!state.sentFinalChunk) {
    state.sentFinalChunk = true
    yield { data: JSON.stringify(buildFinalChatChunk(state)) }
  }
  yield { data: "[DONE]" }
}

function translateAnthropicEventToChatChunks(
  event: AnthropicStreamEventLike,
  state: ChatViaMessagesStreamState,
): Array<ChatCompletionChunk> {
  switch (event.type) {
    case "message_start": {
      state.id = event.message?.id ?? state.id
      state.model = event.message?.model ?? state.model
      mergeAnthropicUsage(state, event.message?.usage)
      return [buildFirstChatChunk(state)]
    }
    case "content_block_start": {
      const block = event.content_block
      state.blockIndex = event.index ?? state.blockIndex
      state.blockType = block?.type
      if (block?.type === "tool_use") {
        const toolIndex = state.toolCallCounter++
        const id = block.id ?? `call_${toolIndex}`
        state.toolCalls.set(state.blockIndex, {
          toolIndex,
          id,
          name: block.name ?? "unknown_function",
          arguments: "",
        })
        return [
          buildDeltaChatChunk(state, {
            tool_calls: [
              {
                index: toolIndex,
                id,
                type: "function",
                function: {
                  name: block.name ?? "unknown_function",
                  arguments: "",
                },
              },
            ],
          }),
        ]
      }
      return []
    }
    case "content_block_delta": {
      return translateContentBlockDelta(event, state)
    }
    case "content_block_stop": {
      state.blockType = undefined
      return []
    }
    case "message_delta": {
      if (event.delta?.stop_reason !== undefined) {
        state.finishReason = mapAnthropicStopReasonToOpenAI(
          event.delta.stop_reason as AnthropicResponse["stop_reason"],
        )
      }
      mergeAnthropicUsage(state, event.usage)
      if (!state.sentFinalChunk) {
        state.sentFinalChunk = true
        return [buildFinalChatChunk(state)]
      }
      return []
    }
    case "message_stop": {
      if (!state.sentFinalChunk) {
        state.sentFinalChunk = true
        return [buildFinalChatChunk(state)]
      }
      return []
    }
    case "error": {
      throw new Error(
        `Anthropic upstream stream error: ${event.error?.message ?? "unknown"}`,
      )
    }
    default: {
      return []
    }
  }
}

function translateContentBlockDelta(
  event: AnthropicStreamEventLike,
  state: ChatViaMessagesStreamState,
): Array<ChatCompletionChunk> {
  const delta = event.delta
  switch (delta?.type) {
    case "text_delta": {
      return [buildDeltaChatChunk(state, { content: delta.text ?? "" })]
    }
    case "thinking_delta": {
      // reasoning_content is the de-facto standard field for interleaved
      // thinking (DeepSeek/Kimi/xAI/Qwen).
      return [
        buildDeltaChatChunk(state, { reasoning_content: delta.thinking ?? "" }),
      ]
    }
    case "signature_delta": {
      return [buildDeltaChatChunk(state, { signature: delta.signature ?? "" })]
    }
    case "input_json_delta": {
      const info = state.toolCalls.get(event.index ?? -1)
      if (!info) return []
      info.arguments += delta.partial_json ?? ""
      return [
        buildDeltaChatChunk(state, {
          tool_calls: [
            {
              index: info.toolIndex,
              function: { arguments: delta.partial_json ?? "" },
            },
          ],
        }),
      ]
    }
    default: {
      return []
    }
  }
}

// Chunk builders

function buildBaseChunk(
  state: ChatViaMessagesStreamState,
): ChatCompletionChunk {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: {}, finish_reason: null, logprobs: null }],
  }
}

function buildFirstChatChunk(
  state: ChatViaMessagesStreamState,
): ChatCompletionChunk {
  return {
    ...buildBaseChunk(state),
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
}

function buildDeltaChatChunk(
  state: ChatViaMessagesStreamState,
  delta: ChatCompletionChunk["choices"][number]["delta"],
): ChatCompletionChunk {
  return {
    ...buildBaseChunk(state),
    choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
  }
}

function buildFinalChatChunk(
  state: ChatViaMessagesStreamState,
): ChatCompletionChunk {
  return {
    ...buildBaseChunk(state),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: state.finishReason,
        logprobs: null,
      },
    ],
    ...(state.usage ? { usage: state.usage } : {}),
  }
}

// Usage

/** Anthropic usage as reported in stream events (all fields optional). */
type PartialAnthropicUsage = Partial<AnthropicUsageLike>

function mergeAnthropicUsage(
  state: ChatViaMessagesStreamState,
  usage: PartialAnthropicUsage | undefined,
): void {
  if (!usage) return
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ] as const) {
    const value = usage[key]
    if (value !== undefined) {
      state.anthropicUsage[key] = value
    }
  }
  state.usage = toOpenAIUsage(state.anthropicUsage)
}

function toOpenAIUsage(usage: PartialAnthropicUsage): OpenAIUsage {
  const base = anthropicUsageToOpenAI({
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    ...(usage.cache_read_input_tokens !== undefined && {
      cache_read_input_tokens: usage.cache_read_input_tokens,
    }),
    ...(usage.cache_creation_input_tokens !== undefined && {
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
    }),
  })
  return {
    prompt_tokens: base.prompt_tokens,
    completion_tokens: base.completion_tokens,
    total_tokens: base.prompt_tokens + base.completion_tokens,
    ...(base.prompt_tokens_details && {
      prompt_tokens_details: base.prompt_tokens_details,
    }),
  }
}
