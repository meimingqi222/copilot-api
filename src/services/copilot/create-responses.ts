import type { Context } from "hono"

import type { Account } from "~/lib/accounts"

import { canonicalModelId } from "~/lib/accounts"
import { getAccountProtocol } from "~/lib/request-admission"
import { isChatCompletionResponse } from "~/lib/utils"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { hasVisionInput } from "~/services/copilot/create-responses-once"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"
import {
  supportsResponsesApi,
  translateChatCompletionToResponses,
  translateChatCompletionsStreamToResponses,
  translateResponsesToChatPayload,
  type CopilotStreamEventLike,
  type ResponsesPayload,
  type ResponsesResponse,
} from "~/services/copilot/responses-api"
import { delegateResponsesToNativeAdapter } from "~/services/providers/delegate"

interface CreateResponsesOptions {
  account: Account
  signal?: AbortSignal
  initiatorOverride?: "agent" | "user"
  forwardedHeaders?: Record<string, string | undefined>
  c?: Context
}

export const createResponses = async (
  payload: ResponsesPayload,
  options: CreateResponsesOptions,
): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEventLike> }
  | { accountId: string; response: ResponsesResponse }
> => {
  const routedPayload = {
    ...payload,
    model: canonicalModelId(payload.model),
  }
  const account = options.account

  if (!supportsResponsesApi(routedPayload.model, account)) {
    const chatPayload = translateResponsesToChatPayload(routedPayload)
    const result = await createChatCompletions(chatPayload, {
      signal: options.signal,
      initiatorOverride: options.initiatorOverride,
      account,
      c: options.c,
    })

    if (isChatCompletionResponse(result.response)) {
      return {
        accountId: result.accountId,
        response: translateChatCompletionToResponses(
          result.response,
          routedPayload,
        ),
      }
    }

    return {
      accountId: result.accountId,
      response: translateChatCompletionsStreamToResponses(
        result.response,
        routedPayload,
      ),
    }
  }

  const enableVision = hasVisionInput(routedPayload)
  const initiator =
    options.initiatorOverride
    ?? inferInitiatorFromResponsesPayload(routedPayload)

  return delegateResponsesToNativeAdapter(
    account,
    getAccountProtocol(account),
    routedPayload,
    options.signal,
    {
      initiator,
      enableVision,
      forwardedHeaders: options.forwardedHeaders,
      c: options.c,
    },
  )
}
