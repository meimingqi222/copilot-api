import { sanitizeId } from "~/lib/id-sanitizer"
import {
  type ChatCompletionChunk,
  type ChatCompletionReasoningDetail,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { extractSignatureAlias, mapOpenAIStopReasonToAnthropic } from "./utils"

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  // Check if the current block index corresponds to any known tool call
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  )
}

function stopCurrentContentBlock(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
  incrementIndex = true,
): void {
  if (!state.contentBlockOpen) {
    return
  }

  events.push({
    type: "content_block_stop",
    index: state.contentBlockIndex,
  })

  if (incrementIndex) {
    state.contentBlockIndex++
  }

  state.contentBlockOpen = false
  state.currentContentBlockType = undefined
}

function ensureTextBlockOpen(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  if (state.contentBlockOpen && state.currentContentBlockType !== "text") {
    stopCurrentContentBlock(state, events)
  }

  if (state.contentBlockOpen) {
    return
  }

  events.push({
    type: "content_block_start",
    index: state.contentBlockIndex,
    content_block: {
      type: "text",
      text: "",
    },
  })
  state.contentBlockOpen = true
  state.currentContentBlockType = "text"
}

function ensureThinkingBlockOpen(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
  bufferedThinking: string | undefined,
): void {
  if (state.contentBlockOpen && state.currentContentBlockType !== "thinking") {
    stopCurrentContentBlock(state, events)
  }

  if (state.contentBlockOpen) {
    return
  }

  // Per Anthropic streaming spec, content_block_start for thinking blocks has
  // ONLY { type: "thinking", thinking: "" }. The signature is sent separately
  // via signature_delta — never in content_block_start.
  events.push({
    type: "content_block_start",
    index: state.contentBlockIndex,
    content_block: {
      type: "thinking",
      thinking: "",
    },
  })
  state.contentBlockOpen = true
  state.currentContentBlockType = "thinking"

  // Emit any buffered thinking content that arrived before the signature
  if (bufferedThinking) {
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "thinking_delta",
        thinking: bufferedThinking,
      },
    })
  }
}

function getReasoningText(
  source: ChatCompletionReasoningDetail,
): string | undefined {
  return source.thinking ?? source.reasoning ?? source.text
}

function getThinkingDelta(
  delta: ChatCompletionChunk["choices"][number]["delta"],
): {
  thinking?: string
  signature?: string
} {
  const reasoningParts: Array<string> = []
  let signature = extractSignatureAlias(delta)

  // Use ?? chaining so only one top-level field is picked per chunk,
  // matching the non-streaming translation and avoiding duplication when
  // the Copilot proxy echoes the same content in multiple alias fields.
  const topLevelReasoning =
    delta.reasoning_text
    ?? delta.thinking
    ?? delta.reasoning
    ?? delta.reasoning_content
  if (topLevelReasoning) {
    reasoningParts.push(topLevelReasoning)
  }

  if (Array.isArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details) {
      const detailText = getReasoningText(detail)
      if (detailText) {
        reasoningParts.push(detailText)
      }

      if (!signature && detail.signature) {
        signature = detail.signature
      }
    }
  }

  return {
    thinking: reasoningParts.length > 0 ? reasoningParts.join("") : undefined,
    signature,
  }
}

// eslint-disable-next-line max-lines-per-function, complexity
export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0, // Will be updated in message_delta when finished
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
          ...(chunk.usage?.prompt_tokens_details?.cache_creation_input_tokens
            !== undefined && {
            cache_creation_input_tokens:
              chunk.usage.prompt_tokens_details.cache_creation_input_tokens,
          }),
        },
      },
    })
    state.messageStartSent = true
  }

  const thinkingDelta = getThinkingDelta(delta)
  if (thinkingDelta.signature && !state.suppressLateThinking) {
    // Signature arrived - create thinking block and flush buffered content.
    // Per Anthropic spec, signature goes only via signature_delta, not in start event.
    ensureThinkingBlockOpen(state, events, state.bufferedThinking || undefined)
    state.bufferedThinking = "" // Clear buffer after flushing

    if (thinkingDelta.thinking) {
      events.push({
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "thinking_delta",
          thinking: thinkingDelta.thinking,
        },
      })
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "signature_delta",
        signature: thinkingDelta.signature,
      },
    })
  } else if (
    thinkingDelta.thinking
    && state.contentBlockOpen
    && state.currentContentBlockType === "thinking"
  ) {
    // Thinking block already open - emit thinking delta directly
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "thinking_delta",
        thinking: thinkingDelta.thinking,
      },
    })
  } else if (thinkingDelta.thinking && !state.suppressLateThinking) {
    // No signature yet and no thinking block open - buffer the thinking content
    state.bufferedThinking += thinkingDelta.thinking
  }

  if (delta.content) {
    if (!state.contentBlockOpen && state.bufferedThinking) {
      // OpenAI reasoning models (e.g. gpt-5.1-codex-mini) send reasoning
      // without a signature. Emit the buffered thinking as an unsigned
      // thinking block so clients can still display reasoning info.
      ensureThinkingBlockOpen(state, events, state.bufferedThinking)
      state.bufferedThinking = ""
      stopCurrentContentBlock(state, events)
      state.suppressLateThinking = true
    }

    if (isToolBlockOpen(state)) {
      // A tool block was open, so close it before starting a text block.
      stopCurrentContentBlock(state, events)
    }

    ensureTextBlockOpen(state, events)

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.content,
      },
    })
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        // New tool call starting.
        if (state.contentBlockOpen) {
          // Close any previously open block.
          stopCurrentContentBlock(state, events)
        }

        const anthropicBlockIndex = state.contentBlockIndex
        const sanitizedId = sanitizeId(toolCall.id)
        state.toolCalls[toolCall.index] = {
          id: sanitizedId,
          name: toolCall.function.name,
          anthropicBlockIndex,
        }

        events.push({
          type: "content_block_start",
          index: anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: sanitizedId,
            name: toolCall.function.name,
            input: {},
          },
        })
        state.contentBlockOpen = true
        state.currentContentBlockType = "tool_use"
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index]
        // Tool call can still be empty
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (toolCallInfo) {
          events.push({
            type: "content_block_delta",
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    // Close the current content block if one is still open.
    // Previous blocks (text/tool_use) were already closed when the next block
    // opened, so we only need to close the last open one here.
    if (state.contentBlockOpen) {
      stopCurrentContentBlock(state, events, false)
    }

    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage?.completion_tokens ?? 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
          ...(chunk.usage?.prompt_tokens_details?.cache_creation_input_tokens
            !== undefined && {
            cache_creation_input_tokens:
              chunk.usage.prompt_tokens_details.cache_creation_input_tokens,
          }),
        },
      },
      {
        type: "message_stop",
      },
    )
    state.messageStopSent = true
  }

  return events
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}
