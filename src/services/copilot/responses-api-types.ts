import type { Account } from "~/lib/legacy-accounts"
import type {
  ModelEndpoint as CopilotModelEndpoint,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { Model } from "~/services/copilot/get-models"

import {
  canonicalModelId,
  canonicalNativeModelId,
  isOAuthAccount,
  parseModelReference,
} from "~/lib/legacy-accounts"
import {
  getOAuthProviderDescriptor,
  isOAuthProviderId,
} from "~/lib/provider-config"
import { getConnectionProvider } from "~/lib/provider-connections"
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
    // Anthropic-only concept smuggled through the OpenAI/Responses usage
    // shape. See docs/refactor-usage-translation.md.
    cache_creation_input_tokens?: number
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
  /**
   * Reasoning items are replayed verbatim in `input` by Responses clients
   * (Codex CLI sends one every turn). Chat Completions has no equivalent item,
   * so the translation merges the summary text into the following assistant
   * message or drops it — but the variant must be modelled, otherwise it falls
   * through to the `function_call_output` branch and becomes a `role: "tool"`
   * message with no `tool_call_id`.
   */
  | {
      type: "reasoning"
      id?: string
      encrypted_content?: string
      summary?: Array<ResponsesReasoningSummaryPart>
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

/**
 * Defaults `reasoning.summary` to "auto" when the client requests a
 * reasoning effort but omits summary. Without an explicit summary, upstream
 * still performs (and bills for) the reasoning but never returns any visible
 * thinking/reasoning output, so the client silently gets no reasoning
 * content at all. Shared by every /v1/responses request builder (Copilot,
 * Codex, ...) so they stay in sync — returns a spreadable partial object.
 */
export function withDefaultReasoningSummary(
  reasoning: ResponsesPayload["reasoning"],
): Pick<ResponsesPayload, "reasoning"> | Record<string, never> {
  if (!reasoning) return {}
  return {
    reasoning: {
      ...reasoning,
      summary: reasoning.summary === undefined ? "auto" : reasoning.summary,
    },
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

// ── Connection 原生版本(Phase 2a)────────────────────────────────
// 与上方 Account 版本语义一致,但面向 ProviderConnection:
// - state.models 缓存优先(URL 形式 endpoint,与 Account 版本相同)
// - fallback 到 connection.models(ModelMapping,短形式 endpoint)
// 仅供 copilot 服务热路径使用;OAuth 原生路径不经此处。

const URL_TO_ENDPOINT: Record<string, CopilotModelEndpoint> = {
  "/chat/completions": "chat",
  "/v1/chat/completions": "chat",
  "/responses": "responses",
  "/v1/responses": "responses",
  "/v1/messages": "messages",
  "/v1/embeddings": "embeddings",
}

function endpointListSupports(
  supported: Array<string> | undefined,
  endpoint: CopilotModelEndpoint,
): boolean {
  if (!supported || supported.length === 0) return false
  return supported.some(
    (ep) => ep === endpoint || URL_TO_ENDPOINT[ep] === endpoint,
  )
}

function getSupportedEndpointsForConnection(
  modelId: string,
  connection: ProviderConnection,
): Array<string> | undefined {
  const exactModelId = canonicalModelId(modelId)
  const cachedModel = state.models?.data.find(
    (model) => canonicalModelId(model.id) === exactModelId,
  )
  if (cachedModel?.supported_endpoints) {
    return cachedModel.supported_endpoints
  }

  const targetModelId = parseModelReference(modelId).nativeModelId
  const mapping = connection.models?.find(
    (m) => canonicalNativeModelId(m.publicId) === targetModelId,
  )
  if (!mapping) return undefined
  // 镜像 mappingToAccountModel:空 endpoints 默认视为仅支持 chat。
  return mapping.endpoints.length > 0 ? mapping.endpoints : ["chat"]
}

function supportsAnyEndpointForConnection(
  modelId: string,
  connection: ProviderConnection,
  endpoint: CopilotModelEndpoint,
): boolean {
  return endpointListSupports(
    getSupportedEndpointsForConnection(modelId, connection),
    endpoint,
  )
}

export function shouldUseResponsesApiForConnection(
  modelId: string,
  connection: ProviderConnection,
): boolean {
  return (
    supportsResponsesApiForConnection(modelId, connection)
    && !supportsChatCompletionsApiForConnection(modelId, connection)
  )
}

export function supportsChatCompletionsApiForConnection(
  modelId: string,
  connection: ProviderConnection,
): boolean {
  return supportsAnyEndpointForConnection(modelId, connection, "chat")
}

export function supportsResponsesApiForConnection(
  modelId: string,
  connection: ProviderConnection,
): boolean {
  if (oauthConnectionSupportsNativeResponses(connection)) {
    return true
  }
  return supportsAnyEndpointForConnection(modelId, connection, "responses")
}

export function supportsMessagesApiForConnection(
  modelId: string,
  connection: ProviderConnection,
): boolean {
  return supportsAnyEndpointForConnection(modelId, connection, "messages")
}

function oauthConnectionSupportsNativeResponses(
  connection: ProviderConnection,
): boolean {
  const provider = getConnectionProvider(connection)
  if (!provider || !isOAuthProviderId(provider)) {
    return false
  }
  const descriptor = getOAuthProviderDescriptor(provider)
  return descriptor.features.includes("native_responses")
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
