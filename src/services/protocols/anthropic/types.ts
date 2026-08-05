// Anthropic API Types

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"
import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens: number
  system?: string | Array<AnthropicTextBlock>
  metadata?: {
    user_id?: string
  }
  stop_sequences?: Array<string>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none"
    name?: string
  }
  thinking?:
    | {
        type: "enabled"
        budget_tokens?: number
        display?: "summarized" | "omitted"
      }
    | {
        type: "adaptive"
        display?: "summarized" | "omitted"
      }
    | {
        type: "disabled"
      }
  output_config?: {
    effort?: "low" | "medium" | "high" | null
  }
  service_tier?: "auto" | "standard_only"
  reasoning_effort?:
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "none"
    | "auto"
    | null
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
}

export interface AnthropicImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data: string
  }
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
  is_error?: boolean
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock

export interface AnthropicUserMessage {
  role: "user"
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: "assistant"
  content: string | Array<AnthropicAssistantContentBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: "standard" | "priority" | "batch"
  }
}

export type AnthropicResponseContentBlock = AnthropicAssistantContentBlock

// Anthropic Stream Event Types
export interface AnthropicMessageStartEvent {
  type: "message_start"
  message: Omit<
    AnthropicResponse,
    "content" | "stop_reason" | "stop_sequence"
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  // Per Anthropic streaming spec, content_block_start for thinking blocks contains
  // ONLY { type: "thinking", thinking: "" }. The signature is sent separately via
  // signature_delta event - never in content_block_start. Do not add signature here.
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string }
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta"
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"]
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface AnthropicMessageStopEvent {
  type: "message_stop"
}

export interface AnthropicPingEvent {
  type: "ping"
}

export interface AnthropicErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// State for streaming translation
export interface AnthropicStreamState {
  messageStartSent: boolean
  messageStopSent: boolean
  messageDeltaSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  currentContentBlockType?: "text" | "thinking" | "tool_use"
  // Buffer for thinking content that arrives before signature
  // (Copilot sends reasoning first, signature later)
  bufferedThinking: string
  // A signature that arrives after unsigned thinking has already been closed
  // is not safely attributable to that block. A new reasoning delta resets it.
  suppressLateThinking: boolean
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
    }
  }
  // Pre-calculated estimate of input tokens from the request payload.
  // Used as a fallback in message_start when the upstream API (e.g. Responses
  // API) does not include usage data until the final streaming chunk, which
  // would otherwise cause message_start to report input_tokens = 0.
  estimatedInputTokens: number
  // Set when finish_reason arrives; message_delta is deferred until usage is
  // available or the stream ends (matching CPA behavior).
  pendingFinishReason?: AnthropicResponse["stop_reason"]
  lastSeenUsage?: NonNullable<ChatCompletionChunk["usage"]>
}

/** Factory to create a fresh AnthropicStreamState with all fields at their default values. */
export function createInitialStreamState(): AnthropicStreamState {
  return {
    messageStartSent: false,
    messageStopSent: false,
    messageDeltaSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    currentContentBlockType: undefined,
    bufferedThinking: "",
    suppressLateThinking: false,
    toolCalls: {},
    estimatedInputTokens: 0,
    pendingFinishReason: undefined,
    lastSeenUsage: undefined,
  }
}

export function extractMessageContentFromAnthropicPayload(
  payload: AnthropicMessagesPayload,
): string {
  const parts: Array<string> = []

  if (payload.system) {
    if (typeof payload.system === "string") {
      parts.unshift(payload.system)
    } else {
      for (const block of payload.system) {
        parts.unshift(block.text)
      }
    }
  }

  for (const msg of payload.messages) {
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") {
      parts.push(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text)
        }
      }
    }
  }

  return parts.join(" ")
}

// Shared streaming types
export type CopilotStream = AsyncIterable<{ data?: string; event?: string }>

export interface AnthropicStreamingUsage {
  input_tokens?: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  )
}

export function isDirectAnthropicResponse(
  response: AsyncIterable<CopilotStreamEventLike> | AnthropicResponse,
): response is AnthropicResponse {
  return Object.hasOwn(response, "content") && Object.hasOwn(response, "usage")
}
