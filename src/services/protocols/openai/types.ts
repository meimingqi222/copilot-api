/**
 * Reverse streaming translation types: Anthropic SSE → OpenAI chat chunks.
 *
 * Mirrors `src/services/protocols/anthropic/types.ts` in the opposite
 * direction — this state machine consumes Anthropic `/v1/messages` stream
 * events (`content_block_start/delta/stop`, `message_start/delta/stop`) and
 * emits OpenAI `chat.completion.chunk` frames.
 */

import type { AnthropicUsageLike } from "~/lib/usage-translation"
import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

/** Parsed shape of an Anthropic streaming SSE event (from `{ data?: string }` frames). */
export interface AnthropicStreamEventLike {
  type: string
  index?: number
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  content_block?: {
    type?: "text" | "thinking" | "tool_use"
    id?: string
    name?: string
    input?: Record<string, unknown>
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  error?: { type?: string; message?: string }
}

export interface ChatViaMessagesStreamState {
  id: string
  model: string
  created: number
  /** Anthropic content block index of the currently-open block. */
  blockIndex: number
  blockType: "text" | "thinking" | "tool_use" | undefined
  /**
   * Tool calls keyed by their Anthropic content block index → OpenAI tool
   * index + accumulated arguments (input_json_delta arrives fragmented).
   */
  toolCalls: Map<
    number,
    { toolIndex: number; id: string; name: string; arguments: string }
  >
  toolCallCounter: number
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"]
  usage?: ChatCompletionChunk["usage"]
  anthropicUsage: Partial<AnthropicUsageLike>
  sentFinalChunk: boolean
}

export function createChatViaMessagesStreamState(): ChatViaMessagesStreamState {
  return {
    id: "",
    model: "",
    created: Math.floor(Date.now() / 1000),
    blockIndex: 0,
    blockType: undefined,
    toolCalls: new Map(),
    toolCallCounter: 0,
    finishReason: null,
    anthropicUsage: {},
    sentFinalChunk: false,
  }
}
