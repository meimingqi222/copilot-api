import type { Account } from "~/lib/accounts"
import type { Model } from "~/services/copilot/get-models"

import {
  canonicalModelId,
  canonicalNativeModelId,
  isOAuthAccount,
  parseModelReference,
} from "~/lib/accounts"
import { getOAuthProviderDescriptor } from "~/lib/provider-config"
import { state } from "~/lib/state"

const CHAT_COMPLETIONS_ENDPOINTS = ["/chat/completions", "/v1/chat/completions"]
const RESPONSES_ENDPOINTS = ["/responses", "/v1/responses"]
const MESSAGES_ENDPOINTS = ["/v1/messages"]

export interface CopilotStreamEventLike {
  data?: string
  event?: string
}

export interface ResponsesUsage {
  input_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens?: number
  output_tokens_details?: {
    reasoning_tokens?: number
  }
  total_tokens?: number
}

export interface ResponsesOutputText {
  type?: string
  text?: string
  annotations?: Array<unknown>
}

export interface ResponsesReasoningSummaryPart {
  text?: string
  type?: string
}

export interface ResponsesReasoningItem {
  type: "reasoning"
  id?: string
  summary?: Array<ResponsesReasoningSummaryPart>
}

export interface ResponsesMessageItem {
  type: "message"
  id?: string
  role?: "assistant"
  content?: Array<ResponsesOutputText>
}

export interface ResponsesFunctionCallItem {
  type: "function_call"
  id?: string
  call_id?: string
  name?: string
  arguments?: string
}

export interface ResponsesTextConfig {
  format:
    | { type: "text" }
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: Record<string, unknown> }
}

export type ResponsesToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; name: string }

export type ResponsesInputContent =
  | {
      type: "input_text"
      text: string
    }
  | {
      type: "input_image"
      image_url: string
      detail?: "low" | "high" | "auto"
    }
  | {
      type: "input_file"
      file_id?: string
      file_url?: string
    }

export type ResponsesInputItem =
  | {
      role: "user" | "assistant"
      content: string | Array<ResponsesInputContent>
    }
  | {
      type: "function_call"
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: "function_call_output"
      call_id: string
      output: string
    }

export type ResponsesTool = {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponsesInputItem>
  background?: boolean | null
  instructions?: string
  max_tool_calls?: number | null
  max_output_tokens?: number | null
  metadata?: Record<string, unknown>
  parallel_tool_calls?: boolean | null
  previous_response_id?: string | null
  stream?: boolean | null
  store?: boolean | null
  temperature?: number | null
  text?: ResponsesTextConfig
  tool_choice?: ResponsesToolChoice
  tools?: Array<ResponsesTool>
  top_p?: number | null
  truncation?: "auto" | "disabled" | null
  user?: string | null
  reasoning?: {
    effort: "low" | "medium" | "high"
    summary?: "auto" | "concise" | "detailed" | null
  }
}

export interface ResponsesResponse {
  id: string
  object?: "response"
  created_at?: number
  completed_at?: number | null
  status?: "completed" | "in_progress" | "failed" | "incomplete"
  error?: { message?: string; type?: string } | null
  model: string
  output?: Array<
    ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesReasoningItem
  >
  output_text?: string
  incomplete_details?: {
    reason?: string
  } | null
  instructions?: string | null
  max_output_tokens?: number | null
  parallel_tool_calls?: boolean | null
  previous_response_id?: string | null
  reasoning?: {
    effort?: "low" | "medium" | "high" | null
    summary?: Array<ResponsesReasoningSummaryPart> | null
  }
  store?: boolean | null
  temperature?: number | null
  text?: ResponsesTextConfig
  tool_choice?: ResponsesToolChoice
  tools?: Array<ResponsesTool>
  top_p?: number | null
  truncation?: "auto" | "disabled" | null
  usage?: ResponsesUsage
  user?: string | null
  metadata?: Record<string, unknown>
}

export function shouldUseResponsesApi(
  modelId: string,
  account: Account,
): boolean {
  return (
    supportsResponsesApi(modelId, account)
    && !supportsChatCompletionsApi(modelId, account)
  )
}

export function supportsChatCompletionsApi(
  modelId: string,
  account: Account,
): boolean {
  return supportsAnyEndpoint(modelId, account, CHAT_COMPLETIONS_ENDPOINTS)
}

export function supportsResponsesApi(
  modelId: string,
  account: Account,
): boolean {
  if (oauthAccountSupportsNativeResponses(account)) {
    return true
  }
  return supportsAnyEndpoint(modelId, account, RESPONSES_ENDPOINTS)
}

function oauthAccountSupportsNativeResponses(account: Account): boolean {
  if (!isOAuthAccount(account)) {
    return false
  }
  const descriptor = getOAuthProviderDescriptor(account.provider)
  return descriptor.features.includes("native_responses")
}

export function supportsMessagesApi(
  modelId: string,
  account: Account,
): boolean {
  return supportsAnyEndpoint(modelId, account, MESSAGES_ENDPOINTS)
}

export function getPublicModelData(model: Model): Model & {
  created: number
  created_at: string
  display_name: string
  owned_by: string
  type: "model"
} {
  return {
    ...model,
    object: "model",
    type: "model",
    created: 0,
    created_at: new Date(0).toISOString(),
    owned_by: model.vendor,
    display_name: model.name,
  }
}

function supportsAnyEndpoint(
  modelId: string,
  account: Account,
  endpoints: Array<string>,
): boolean {
  const supportedEndpoints = getSupportedEndpoints(modelId, account)
  if (!supportedEndpoints || supportedEndpoints.length === 0) {
    return false
  }

  return supportedEndpoints.some((endpoint) => endpoints.includes(endpoint))
}

function getSupportedEndpoints(
  modelId: string,
  account: Account,
): Array<string> | undefined {
  const exactModelId = canonicalModelId(modelId)
  const targetModelId = parseModelReference(modelId).nativeModelId
  const cachedModel = state.models?.data.find(
    (model) => canonicalModelId(model.id) === exactModelId,
  )
  if (cachedModel?.supported_endpoints) {
    return cachedModel.supported_endpoints
  }

  const accountModel = account.availableModels?.find(
    (model) => canonicalNativeModelId(model.id) === targetModelId,
  )
  return accountModel?.supportedEndpoints
}

export function extractMessageContentFromResponsesPayload(
  payload: ResponsesPayload,
): string {
  const { input } = payload
  if (typeof input === "string") {
    return input
  }

  const parts: Array<string> = []
  for (const item of input) {
    if (!("content" in item) || item.role !== "user") continue
    if (typeof item.content === "string") {
      parts.push(item.content)
      continue
    }
    if (!Array.isArray(item.content)) continue
    for (const c of item.content) {
      if (c.type === "input_text" && c.text) {
        parts.push(c.text)
      }
    }
  }
  return parts.join(" ")
}
