import type { Context } from "hono"

import type {
  ProviderDescriptor,
  ProviderFeature,
  ProviderId,
} from "~/lib/provider-config"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/provider-connections/types"
import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { EmbeddingResponse } from "~/services/copilot/create-embeddings"
import type {
  CopilotStreamEventLike,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { ProtocolAdapter } from "~/services/protocols/types"

export interface RequestExecutionContext {
  initiator?: "agent" | "user"
  enableVision?: boolean
  forwardedHeaders?: Record<string, string | undefined>
  c?: Context
  /**
   * True when the client connected via Responses WebSocket
   * (`GET /v1/responses` upgrade). Enables upstream WS for Codex/xAI
   * (CPA DownstreamWebsocket + websockets executor).
   */
  downstreamWebsocket?: boolean
  /**
   * Sticky id for reusing one upstream WS connection across multi-turn
   * `response.create` on the same client socket (CPA execution session).
   */
  executionSessionId?: string
  /** Isolation scope for reconnectable in-memory Responses transcripts. */
  transcriptScopeId?: string
  /** Correlates low-overhead memory checkpoints for one Responses WS turn. */
  memoryTraceId?: string
  /**
   * Force the upstream to use HTTP POST, skipping the WS path even when the
   * client connected via WebSocket. Set by the WS handler's same-account
   * recovery after a lazy connection failure (socket dropped mid-iteration)
   * so `createResponses` does not re-enter the WS path on the retry.
   */
  forceUpstreamHttp?: boolean
}

export type ProviderChatResult =
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }

export type ProviderResponsesResult =
  | { accountId: string; response: AsyncIterable<CopilotStreamEventLike> }
  | { accountId: string; response: ResponsesResponse }

export type ProviderEmbeddingsResult = {
  accountId: string
  response: EmbeddingResponse
}

export type ProviderMessagesResult =
  | { accountId: string; response: AsyncIterable<unknown> }
  | { accountId: string; response: Record<string, unknown> }

export interface ProviderRuntime {
  id: ProviderId
  descriptor: ProviderDescriptor
  /** 对应的协议适配器。用于消除 provider↔protocol 手动映射表。 */
  adapter?: ProtocolAdapter
  supports(connection: ProviderConnection, feature: ProviderFeature): boolean
  refreshModels(connection: ProviderConnection): Promise<Array<ModelMapping>>
  refreshQuota?(
    connection: ProviderConnection,
  ): Promise<QuotaSnapshot | undefined>
  refreshAuth?(connection: ProviderConnection): Promise<void>
  getFallbackModels?(connection: ProviderConnection): Array<ModelMapping>
}
