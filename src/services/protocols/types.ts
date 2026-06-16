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
} from "~/services/copilot/create-chat-completions"
import type {
  EmbeddingRequest,
  EmbeddingResponse,
} from "~/services/copilot/create-embeddings"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

export type AdapterChatResult =
  | { credentialId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { credentialId: string; response: ChatCompletionResponse }

export type AdapterEmbeddingsResult = {
  credentialId: string
  response: EmbeddingResponse
}

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

export type AdapterMessagesResult =
  | { credentialId: string; response: AsyncIterable<unknown> }
  | { credentialId: string; response: Record<string, unknown> }

export type AdapterResponsesResult =
  | { credentialId: string; response: AsyncIterable<CopilotStreamEventLike> }
  | { credentialId: string; response: ResponsesResponse }

export interface ProtocolAdapter {
  protocol: ProviderProtocol

  /** 自动发现模型(可选)。返回上游模型映射,调用方按 mode 合并到 connection.models。 */
  discoverModels?(
    connection: ProviderConnection,
    credential: ApiCredential,
    signal?: AbortSignal,
  ): Promise<Array<ModelMapping>>

  createChatCompletions?(
    target: RouteTarget,
    connection: ProviderConnection,
    credential: ApiCredential,
    payload: ChatCompletionsPayload,
    signal?: AbortSignal,
    ctx?: RequestExecutionContext,
  ): Promise<AdapterChatResult>

  createMessages?(
    target: RouteTarget,
    connection: ProviderConnection,
    credential: ApiCredential,
    payload: AnthropicMessagesPayload,
    signal?: AbortSignal,
    ctx?: RequestExecutionContext,
  ): Promise<AdapterMessagesResult>

  createResponses?(
    target: RouteTarget,
    connection: ProviderConnection,
    credential: ApiCredential,
    payload: ResponsesPayload,
    signal?: AbortSignal,
    ctx?: RequestExecutionContext,
  ): Promise<AdapterResponsesResult>

  createEmbeddings?(
    target: RouteTarget,
    connection: ProviderConnection,
    credential: ApiCredential,
    payload: EmbeddingRequest,
    signal?: AbortSignal,
  ): Promise<AdapterEmbeddingsResult>
}

export { type AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
