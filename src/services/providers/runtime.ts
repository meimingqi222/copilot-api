import type { Context } from "hono"

import type { Account, AccountModel, QuotaSnapshot } from "~/lib/accounts"
import type {
  ProviderDescriptor,
  ProviderFeature,
  ProviderId,
} from "~/lib/provider-config"
import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { EmbeddingResponse } from "~/services/copilot/create-embeddings"
import type {
  CopilotStreamEventLike,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

export interface RequestExecutionContext {
  initiator?: "agent" | "user"
  enableVision?: boolean
  forwardedHeaders?: Record<string, string | undefined>
  c?: Context
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
  supports(account: Account, feature: ProviderFeature): boolean
  refreshModels(account: Account): Promise<Array<AccountModel>>
  refreshQuota?(account: Account): Promise<QuotaSnapshot | undefined>
  refreshAuth?(account: Account): Promise<void>
  getFallbackModels?(account: Account): Array<AccountModel>
}
