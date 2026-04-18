import type { Account } from "~/lib/accounts"

import { canonicalModelId } from "~/lib/accounts"
import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
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
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

interface CreateResponsesOptions {
  account: Account
  signal?: AbortSignal
  initiatorOverride?: "agent" | "user"
}

export const createResponses = async (
  payload: ResponsesPayload,
  options: CreateResponsesOptions,
): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEventLike> }
  | { accountId: string; response: ResponsesResponse }
> => {
  initializeProviderRegistry()
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

  const runtime = getProviderRuntime(account.provider)
  if (!runtime.createResponses) {
    throw new Error(
      `Provider "${account.provider}" does not implement native responses`,
    )
  }

  return runtime.createResponses(account, routedPayload, options.signal, {
    initiator,
    enableVision,
  })
}

function hasVisionInput(payload: ResponsesPayload): boolean {
  if (typeof payload.input === "string") {
    return false
  }

  return payload.input.some(
    (item) =>
      "role" in item
      && Array.isArray(item.content)
      && item.content.some((content) => content.type === "input_image"),
  )
}

function isChatCompletionResponse(
  response: AsyncIterable<CopilotStreamEventLike> | ChatCompletionResponse,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}
