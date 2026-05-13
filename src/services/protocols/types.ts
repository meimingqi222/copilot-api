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
import type { RequestExecutionContext } from "~/services/providers/runtime"

export type AdapterChatResult =
  | { credentialId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { credentialId: string; response: ChatCompletionResponse }

export type AdapterEmbeddingsResult = {
  credentialId: string
  response: EmbeddingResponse
}

/**
 * 通用 Anthropic Messages payload 占位类型(避免在此引入完整 schema)。
 * 真实路由路径会传入 `~/routes/messages` 处理过的对象。
 */
export type AnthropicMessagesPayload = Record<string, unknown> & {
  model: string
  stream?: boolean
}

export type AdapterMessagesResult =
  | { credentialId: string; response: AsyncIterable<unknown> }
  | { credentialId: string; response: Record<string, unknown> }

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

  createEmbeddings?(
    target: RouteTarget,
    connection: ProviderConnection,
    credential: ApiCredential,
    payload: EmbeddingRequest,
    signal?: AbortSignal,
  ): Promise<AdapterEmbeddingsResult>
}
