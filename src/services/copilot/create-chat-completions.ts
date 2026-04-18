import type { Account } from "~/lib/accounts"

import { canonicalModelId } from "~/lib/accounts"
import { inferInitiatorFromChatMessages } from "~/services/copilot/initiator"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

interface CreateChatCompletionsOptions {
  account: Account
  signal?: AbortSignal
  initiatorOverride?: "agent" | "user"
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options: CreateChatCompletionsOptions,
): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }
> => {
  const normalizedPayload = {
    ...payload,
    model: canonicalModelId(payload.model),
  }

  initializeProviderRegistry()
  const initiator =
    options.initiatorOverride
    ?? inferInitiatorFromChatMessages(normalizedPayload.messages)
  const enableVision = normalizedPayload.messages.some(
    (message) =>
      typeof message.content !== "string"
      && message.content?.some((content) => content.type === "image_url"),
  )

  return getProviderRuntime(options.account.provider).createChatCompletions(
    options.account,
    normalizedPayload,
    options.signal,
    {
      initiator,
      enableVision,
    },
  )
}

// Streaming types

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

// Non-streaming types

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

// Payload types

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
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | null
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

export interface TextPart {
  type: "text"
  text: string
}

export interface OutputTextPart {
  type: "output_text"
  text: string
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
