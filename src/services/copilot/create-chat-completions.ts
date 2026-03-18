import consola from "consola"
import { events } from "fetch-event-stream"

import {
  getAccountForModel,
  markAccountExhausted,
  tryNextAccountForModel,
} from "~/lib/accounts"
import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  reportUpstreamRateLimit,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  shouldUseResponsesApi,
  translateResponsesStreamToChatCompletions,
  translateResponsesToChatCompletion,
  translateToResponsesPayload,
  type ResponsesResponse,
} from "~/services/copilot/responses-api"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
  initiatorOverride?: "agent" | "user",
): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }
> => {
  const account = getAccountForModel(payload.model)
  if (!account.copilotToken) throw new Error("Copilot token not found")
  const useResponsesApi = shouldUseResponsesApi(payload.model, account)

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
  const initiator = initiatorOverride ?? (isAgentCall ? "agent" : "user")

  const doRequest = async (requestAccount: typeof account) => {
    const reqHeaders: Record<string, string> = {
      ...copilotHeaders(requestAccount, enableVision),
      "editor-version": `vscode/${state.vsCodeVersion}`,
      "X-Initiator": initiator,
    }
    return fetch(
      `${copilotBaseUrl(state)}${useResponsesApi ? "/responses" : "/chat/completions"}`,
      {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(
          useResponsesApi ? translateToResponsesPayload(payload) : payload,
        ),
        signal,
      },
    )
  }

  let usedAccount = account
  let response = await doRequest(account)

  // Handle 429 by marking account exhausted and trying next account for the same model
  if (!response.ok && response.status === 429) {
    await reportUpstreamRateLimit(account.id, response)
    markAccountExhausted(account.id)
    const retryResult = await tryNextAccountForModel(
      account,
      payload.model,
      doRequest,
    )
    response = retryResult.response
    usedAccount = retryResult.account
  }

  if (!response.ok) {
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

  await reportUpstreamSuccess(usedAccount.id)

  if (payload.stream) {
    const stream = events(
      response,
    ) as unknown as AsyncIterable<CopilotStreamEvent>
    return {
      accountId: usedAccount.id,
      response:
        useResponsesApi ?
          (translateResponsesStreamToChatCompletions(
            stream,
            payload.model,
          ) as AsyncIterable<CopilotStreamEvent>)
        : stream,
    }
  }

  const responseBody = (await response.json()) as
    | ChatCompletionResponse
    | ResponsesResponse

  return {
    accountId: usedAccount.id,
    response:
      useResponsesApi ?
        translateResponsesToChatCompletion(responseBody as ResponsesResponse)
      : (responseBody as ChatCompletionResponse),
  }
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
