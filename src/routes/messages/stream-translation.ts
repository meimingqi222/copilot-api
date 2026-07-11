import { sanitizeId } from "~/lib/id-sanitizer"
import { openAIUsageToAnthropic } from "~/lib/usage-translation"
import {
  type ChatCompletionChunk,
  type ChatCompletionReasoningDetail,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessageDeltaEvent,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { extractSignatureAlias, mapOpenAIStopReasonToAnthropic } from "./utils"

type OpenAIStreamUsage = NonNullable<ChatCompletionChunk["usage"]>

function buildAnthropicStreamUsage(
  usage: OpenAIStreamUsage | undefined,
  estimatedInputTokens: number,
): NonNullable<AnthropicMessageDeltaEvent["usage"]> {
  if (!usage) {
    return {
      input_tokens: estimatedInputTokens,
      output_tokens: 0,
    }
  }

  return openAIUsageToAnthropic(usage)
}

function tryEmitDeferredMessageDelta(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
  usage?: OpenAIStreamUsage,
): void {
  if (!state.pendingFinishReason || state.messageDeltaSent) {
    return
  }

  const resolvedUsage = usage ?? state.lastSeenUsage
  if (!resolvedUsage) {
    return
  }

  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: state.pendingFinishReason,
        stop_sequence: null,
      },
      usage: buildAnthropicStreamUsage(
        resolvedUsage,
        state.estimatedInputTokens,
      ),
    },
    {
      type: "message_stop",
    },
  )
  state.messageDeltaSent = true
  state.messageStopSent = true
}

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

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.usage) {
    state.lastSeenUsage = chunk.usage
  }

  // Usage-only chunks (common after Responses API finish) may have no choices.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!chunk.choices?.length) {
    tryEmitDeferredMessageDelta(state, events, chunk.usage)
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    // For models that use the Responses API (e.g. gpt-5.3-codex), usage data
    // only arrives in the final response.completed chunk, so the first
    // streaming chunk has no usage.  Fall back to the pre-calculated estimate
    // so message_start carries a meaningful input_tokens value from the start.
    const usage =
      chunk.usage ?
        openAIUsageToAnthropic(chunk.usage)
      : { input_tokens: state.estimatedInputTokens, output_tokens: 0 }

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
          ...usage,
          output_tokens: 0, // Will be updated in message_delta when finished
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
    if (!state.contentBlockOpen && state.bufferedThinking) {
      // If unsigned reasoning is followed directly by a tool call, flush the
      // buffered thinking before opening the tool_use block so Anthropic
      // clients can still display it.
      ensureThinkingBlockOpen(state, events, state.bufferedThinking)
      state.bufferedThinking = ""
      stopCurrentContentBlock(state, events)
      state.suppressLateThinking = true
    }

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

    state.pendingFinishReason = mapOpenAIStopReasonToAnthropic(
      choice.finish_reason,
    )
  }

  tryEmitDeferredMessageDelta(state, events, chunk.usage)

  return events
}

export function translateStreamEndEvents(
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (!state.pendingFinishReason || state.messageDeltaSent) {
    return events
  }

  if (state.contentBlockOpen) {
    stopCurrentContentBlock(state, events, false)
  }

  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: state.pendingFinishReason,
        stop_sequence: null,
      },
      usage: buildAnthropicStreamUsage(
        state.lastSeenUsage,
        state.estimatedInputTokens,
      ),
    },
    {
      type: "message_stop",
    },
  )
  state.messageDeltaSent = true
  state.messageStopSent = true

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
