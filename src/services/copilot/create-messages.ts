import type { Context } from "hono"

import type { Account } from "~/lib/accounts"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import { getAccountProtocol } from "~/lib/request-admission"
import { delegateMessagesToNativeAdapter } from "~/services/providers/delegate"

export {
  hoistToolResultImages,
  translateToCopilotMessages,
} from "~/services/copilot/create-messages-translate"

interface CreateMessagesOptions {
  account: Account
  signal?: AbortSignal
  forwardedHeaders?: Record<string, string | undefined>
  initiatorOverride?: "agent" | "user"
  c?: Context
}

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  options: CreateMessagesOptions,
): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEventLike> }
  | { accountId: string; response: AnthropicResponse }
> => {
  return delegateMessagesToNativeAdapter(
    options.account,
    getAccountProtocol(options.account),
    payload,
    options.signal,
    {
      initiator: options.initiatorOverride,
      forwardedHeaders: options.forwardedHeaders,
      c: options.c,
    },
  ) as Promise<
    | { accountId: string; response: AsyncIterable<CopilotStreamEventLike> }
    | { accountId: string; response: AnthropicResponse }
  >
}
