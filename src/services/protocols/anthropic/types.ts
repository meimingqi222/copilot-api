// Anthropic API Types

import type { CopilotStreamEventLike } from "~/services/protocols/responses/types"

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
  tools?: Array<AnthropicTool | AnthropicServerTool>
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
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | null
    format?: { type: "json_schema"; schema: Record<string, unknown> }
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

interface AnthropicCacheControl {
  type: "ephemeral"
  ttl?: "5m" | "1h"
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: AnthropicCacheControl
}

type AnthropicImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"

/**
 * Anthropic accepts two image sources. `base64` is the original inline form;
 * `url` lets the API fetch a remote image itself, which is the only way an
 * OpenAI `image_url` pointing at http(s) can survive the translation to
 * Messages (see the IR messages encoder). Consumers must switch on
 * `source.type` — a `url` source carries no `media_type`/`data`.
 */
export type AnthropicImageSource =
  | {
      type: "base64"
      media_type: AnthropicImageMediaType
      data: string
    }
  | {
      type: "url"
      url: string
    }

export interface AnthropicImageBlock {
  type: "image"
  source: AnthropicImageSource
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
  is_error?: boolean
}

interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

/**
 * A tool Anthropic ran server-side (e.g. `web_search`). The client does not
 * execute it; the results arrive in a following `web_search_tool_result`
 * block, which is a *user* block per the Messages wire.
 */
interface AnthropicServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

interface AnthropicWebSearchResult {
  type: "web_search_result"
  url: string
  title?: string
  page_age?: string
  encrypted_content?: string
}

export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content: Array<AnthropicWebSearchResult>
}

/** Declaration of a server tool, e.g. `{ type: "web_search_20250305", … }`. */
export interface AnthropicServerTool {
  type: string
  name: string
  max_uses?: number
  allowed_domains?: Array<string>
  blocked_domains?: Array<string>
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock
  | AnthropicWebSearchToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicServerToolUseBlock

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
  content: Array<
    AnthropicAssistantContentBlock | AnthropicWebSearchToolResultBlock
  >
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

interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  // Per Anthropic streaming spec, content_block_start for thinking blocks contains
  // ONLY { type: "thinking", thinking: "" }. The signature is sent separately via
  // signature_delta event - never in content_block_start. Do not add signature here.
  content_block:
    | { type: "text"; text: string }
    | AnthropicImageBlock
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string }
    | (Omit<AnthropicServerToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | AnthropicWebSearchToolResultBlock
}

interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
}

interface AnthropicContentBlockStopEvent {
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

interface AnthropicMessageStopEvent {
  type: "message_stop"
}

interface AnthropicPingEvent {
  type: "ping"
}

export interface AnthropicErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
    /**
     * Numeric status-like code letting downstream one-shot clients (ZCode,
     * opencode, Anthropic SDK) classify the failure as retryable (`>=500`,
     * 429). Providers that only stream a 200 + inline error event (CodeBuddy,
     * etc.) otherwise surface as a non-retryable generic failure.
     */
    code?: number
    status?: number
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
export interface AnthropicStreamingUsage {
  input_tokens?: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export { isAsyncIterable } from "../result-shape"

export function isDirectAnthropicResponse(
  response: AsyncIterable<CopilotStreamEventLike> | AnthropicResponse,
): response is AnthropicResponse {
  return Object.hasOwn(response, "content") && Object.hasOwn(response, "usage")
}
