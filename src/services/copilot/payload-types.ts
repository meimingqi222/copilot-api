/**
 * Chat Completions / Embeddings 的共享 payload 与响应类型。
 *
 * Phase 2e:从 create-chat-completions.ts / create-embeddings.ts 提取,
 * 使类型定义与 wrapper 的执行路径解耦(delegate 拆除后 ~30 个导入方
 * 仍从原模块 re-export 导入,不破坏)。
 */

// ── Chat Completions streaming types ────────────────────────────────

export interface CopilotStreamEvent {
  data?: string
  event?: string
}

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_creation_input_tokens?: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens?: number
      rejected_prediction_tokens?: number
      reasoning_tokens?: number
    }
  }
}

export interface ChatCompletionReasoningDetail {
  type?: string
  text?: string
  reasoning?: string
  thinking?: string
  signature?: string
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
  reasoning?: string | null
  reasoning_text?: string | null
  reasoning_content?: string | null
  reasoning_opaque?: string | null
  thinking?: string | null
  signature?: string | null
  reasoning_signature?: string | null
  thinking_signature?: string | null
  reasoning_details?: Array<ChatCompletionReasoningDetail> | null
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// ── Chat Completions non-streaming types ────────────────────────────

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_creation_input_tokens?: number
    }
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | Array<ContentPart> | null
  tool_calls?: Array<ToolCall>
  reasoning?: string | null
  reasoning_text?: string | null
  reasoning_content?: string | null
  reasoning_opaque?: string | null
  thinking?: string | null
  signature?: string | null
  reasoning_signature?: string | null
  thinking_signature?: string | null
  reasoning_details?: Array<ChatCompletionReasoningDetail> | null
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// ── Chat Completions payload types ──────────────────────────────────

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  /** OpenAI/Codex cache routing key — also used for Windsurf conversation buckets. */
  prompt_cache_key?: string | null
  reasoning_effort?:
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "none"
    | "auto"
    | null
  reasoning?: Record<string, unknown> | null
  thinking?:
    | {
        type: "enabled"
        budget_tokens?: number
      }
    | {
        type: "adaptive"
      }
    | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
  reasoning_text?: string | null
  /** Historical reasoning details, including signatures when available. */
  reasoning_details?: Array<ChatCompletionReasoningDetail> | null
  /**
   * Historical assistant reasoning carried through translation
   * (DeepSeek thinking mode requires it round-tripped with tool calls).
   */
  reasoning_content?: string | null
  /**
   * OpenRouter's spelling. Declared for the same reason `ResponseMessage`
   * declares it: clients are as uncontrolled as upstreams, and a client that
   * replays an OpenRouter assistant turn verbatim sends this rather than
   * `reasoning_content`. Dropping it silently breaks signed-thinking round
   * trips on the Anthropic path, which discards unsigned reasoning outright.
   */
  reasoning?: string | null
  /** Anthropic-style reasoning flattened to the top level by some proxies. */
  thinking?: string | null
  signature?: string | null
  reasoning_signature?: string | null
  thinking_signature?: string | null
  /**
   * The spelling this proxy's own Windsurf path emits (see
   * `windsurf/collect-response.ts` and `windsurf/chunk-builders.ts`). Declared
   * here so a client replaying a Windsurf assistant turn verbatim round-trips
   * its signature instead of silently dropping it. Read via
   * `extractSignatureAlias`.
   */
  reasoning_opaque?: string | null
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart =
  | TextPart
  | ImagePart
  | OutputTextPart
  | ReasoningContentPart

/**
 * Anthropic prompt-cache breakpoint smuggled through the Chat Completions
 * shape — the OpenRouter convention, and the only way a chat client can place
 * one. Honoured on the chat→messages path; ignored by chat upstreams.
 */
export interface ChatCacheControl {
  type: "ephemeral"
  ttl?: "5m" | "1h"
}

export interface TextPart {
  type: "text"
  text: string
  cache_control?: ChatCacheControl
}

export interface OutputTextPart {
  type: "output_text"
  text: string
  cache_control?: ChatCacheControl
}

export interface ReasoningContentPart {
  type: "reasoning" | "thinking"
  text?: string
  reasoning?: string
  thinking?: string
  signature?: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}

export function extractMessageContentFromChatCompletionsPayload(
  payload: ChatCompletionsPayload,
): string {
  const parts: Array<string> = []
  for (const msg of payload.messages) {
    if (msg.role !== "user" && msg.role !== "system") continue
    if (typeof msg.content === "string") {
      parts.push(msg.content)
      continue
    }
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "text" || part.type === "output_text") {
        parts.push(part.text)
      }
    }
  }
  return parts.join(" ")
}

// ── Embeddings types ─────────────────────────────────────────────────

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
