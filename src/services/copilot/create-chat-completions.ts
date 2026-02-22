import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  reportUpstreamRateLimit,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"
import { state } from "~/lib/state"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Infer who initiated this turn from the latest non-system message.
  const lastConversationMessage = [...payload.messages]
    .reverse()
    .find((msg) => !["developer", "system"].includes(msg.role))
  const isAgentCall = ["assistant", "tool"].includes(
    lastConversationMessage?.role ?? "",
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    if (response.status === 429) {
      await reportUpstreamRateLimit(response)
    }
    const errorBody = await response.text().catch(() => "(unreadable)")
    consola.error(
      "Failed to create chat completions",
      response.status,
      errorBody,
    )
    consola.error("Request payload was:", JSON.stringify(payload))
    throw new HTTPError(
      "Failed to create chat completions",
      response,
      errorBody,
    )
  }

  await reportUpstreamSuccess()

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

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
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
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
  reasoning_content?: string | null
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
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | Array<ContentPart> | null
  tool_calls?: Array<ToolCall>
  reasoning?: string | null
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
  reasoning_effort?: "low" | "medium" | "high" | null
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
