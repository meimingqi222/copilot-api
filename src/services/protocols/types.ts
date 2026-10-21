/**
 * Protocol Adapter 接口。
 *
 * 把"调用协议"从"上游服务实例"中抽离。所有 OpenAI-compatible 的上游
 * (DeepSeek、OpenRouter、自建 vLLM、SiliconFlow 等)共享同一 adapter,
 * 仅通过 ProviderConnection 配置区分。
 */

import type {
  ApiCredential,
  ModelMapping,
  ProviderConnection,
  ProviderProtocol,
  RouteTarget,
} from "~/lib/provider-connections"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
  EmbeddingRequest,
  EmbeddingResponse,
} from "~/services/protocols/chat/types"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

export type AdapterChatResult =
  | { credentialId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { credentialId: string; response: ChatCompletionResponse }

export type AdapterEmbeddingsResult = {
  credentialId: string
  response: EmbeddingResponse
}

import type { AnthropicMessagesPayload } from "./anthropic/types"
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  GeminiStreamEvent,
} from "./gemini/types"

export type AdapterMessagesResult =
  | { credentialId: string; response: AsyncIterable<unknown> }
  | { credentialId: string; response: Record<string, unknown> }

export type AdapterResponsesResult =
  | { credentialId: string; response: AsyncIterable<CopilotStreamEventLike> }
  | { credentialId: string; response: ResponsesResponse }

export type AdapterGeminiResult =
  | { credentialId: string; response: AsyncIterable<GeminiStreamEvent> }
  | { credentialId: string; response: GeminiGenerateContentResponse }

/** Shared parameters for all adapter create* methods. */
interface AdapterParams<TPayload> {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: TPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}

/** Parameters for discoverModels (no target/payload). */
interface DiscoverModelsParams {
  connection: ProviderConnection
  credential: ApiCredential
  signal?: AbortSignal
}

export interface ProtocolAdapter {
  protocol: ProviderProtocol

  /**
   * Override the model id sent to the adapter when a protocol needs the
   * public head id rather than the pre-resolved `upstreamModelId` (e.g.
   * Windsurf selects its SKU from `reasoning_effort` inside the adapter).
   */
  resolveDispatchModel?(target: RouteTarget): string

  /**
   * Handle a model-scoped rate limit (e.g. CodeBuddy 6004) without penalizing
   * the whole credential/connection. Returns `true` when handled.
   */
  recordModelRateLimit?(params: {
    connection: ProviderConnection
    credential: ApiCredential
    model: string
    status: number
    body?: string
  }): boolean

  /**
   * True when `model` on `connection` is an explicit zero-credit model whose
   * credit refusal should be scoped to that model rather than exhausting the
   * entire account.
   */
  isModelCreditExempt?(connection: ProviderConnection, model: string): boolean

  /** 自动发现模型(可选)。返回上游模型映射,调用方按 mode 合并到 connection.models。 */
  discoverModels?(params: DiscoverModelsParams): Promise<Array<ModelMapping>>

  createChatCompletions?(
    params: AdapterParams<ChatCompletionsPayload>,
  ): Promise<AdapterChatResult>

  createMessages?(
    params: AdapterParams<AnthropicMessagesPayload>,
  ): Promise<AdapterMessagesResult>

  createResponses?(
    params: AdapterParams<ResponsesPayload>,
  ): Promise<AdapterResponsesResult>

  createGeminiGenerateContent?(
    params: AdapterParams<GeminiGenerateContentRequest>,
  ): Promise<AdapterGeminiResult>

  createEmbeddings?(
    params: Omit<AdapterParams<EmbeddingRequest>, "ctx">,
  ): Promise<AdapterEmbeddingsResult>
}

export { type AnthropicMessagesPayload } from "./anthropic/types"
