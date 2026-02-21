import { sanitizeId } from "~/lib/id-sanitizer"
import {
  type ChatCompletionChunk,
  type ChatCompletionReasoningDetail,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

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
  signature?: string,
): void {
  if (state.contentBlockOpen && state.currentContentBlockType !== "thinking") {
    stopCurrentContentBlock(state, events)
  }

  if (state.contentBlockOpen) {
    return
  }

  events.push({
    type: "content_block_start",
    index: state.contentBlockIndex,
    content_block: {
      type: "thinking",
      thinking: "",
      ...(signature ? { signature } : {}),
    },
  })
  state.contentBlockOpen = true
  state.currentContentBlockType = "thinking"
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
  let signature =
    delta.thinking_signature
    ?? delta.reasoning_signature
    ?? delta.signature
    ?? undefined

  if (delta.thinking) {
    reasoningParts.push(delta.thinking)
  }

  if (delta.reasoning_content) {
    reasoningParts.push(delta.reasoning_content)
  }

  if (delta.reasoning) {
    reasoningParts.push(delta.reasoning)
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
        },
      },
    })
    state.messageStartSent = true
  }

  const thinkingDelta = getThinkingDelta(delta)
  if (thinkingDelta.thinking || thinkingDelta.signature) {
    ensureThinkingBlockOpen(state, events, thinkingDelta.signature)

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

    if (thinkingDelta.signature) {
      events.push({
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "signature_delta",
          signature: thinkingDelta.signature,
        },
      })
    }
  }

  if (delta.content) {
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
    // Close all open tool call blocks that were never explicitly closed, then
    // close the current content block (text/thinking) if one is open.
    const openToolBlocks = Object.values(state.toolCalls)
      .filter((tc) => tc.anthropicBlockIndex !== state.contentBlockIndex)
      .sort((a, b) => a.anthropicBlockIndex - b.anthropicBlockIndex)

    for (const tc of openToolBlocks) {
      events.push({
        type: "content_block_stop",
        index: tc.anthropicBlockIndex,
      })
    }

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
        },
      },
      {
        type: "message_stop",
      },
    )
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
