import type { Account, AccountModel, QuotaSnapshot } from "~/lib/accounts"
import type {
  ProviderDescriptor,
  ProviderFeature,
  ProviderId,
} from "~/lib/provider-config"
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

export interface RequestExecutionContext {
  initiator?: "agent" | "user"
  enableVision?: boolean
  forwardedHeaders?: Record<string, string | undefined>
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

export interface ProviderRuntime {
  id: ProviderId
  descriptor: ProviderDescriptor
  supports(account: Account, feature: ProviderFeature): boolean
  refreshModels(account: Account): Promise<Array<AccountModel>>
  refreshQuota?(account: Account): Promise<QuotaSnapshot | undefined>
  refreshAuth?(account: Account): Promise<void>
  createChatCompletions(
    account: Account,
    payload: ChatCompletionsPayload,
    signal?: AbortSignal,
    ctx?: RequestExecutionContext,
  ): Promise<ProviderChatResult>
  createResponses?(
    account: Account,
    payload: ResponsesPayload,
    signal?: AbortSignal,
    ctx?: RequestExecutionContext,
  ): Promise<ProviderResponsesResult>
  createEmbeddings?(
    account: Account,
    payload: EmbeddingRequest,
    signal?: AbortSignal,
  ): Promise<ProviderEmbeddingsResult>
}
