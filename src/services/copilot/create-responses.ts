import { events } from "fetch-event-stream"

import { getAccountForModel } from "~/lib/accounts"
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"
import { executeCopilotRequestWithRetry } from "~/services/copilot/request"
import {
  supportsResponsesApi,
  translateChatCompletionToResponses,
  translateChatCompletionsStreamToResponses,
  translateResponsesToChatPayload,
  type CopilotStreamEventLike,
  type ResponsesPayload,
  type ResponsesResponse,
} from "~/services/copilot/responses-api"

export const createResponses = async (
  payload: ResponsesPayload,
  signal?: AbortSignal,
  initiatorOverride?: "agent" | "user",
): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEventLike> }
  | { accountId: string; response: ResponsesResponse }
> => {
  const account = getAccountForModel(payload.model)

  if (!supportsResponsesApi(payload.model, account)) {
    const chatPayload = translateResponsesToChatPayload(payload)
    const result = await createChatCompletions(
      chatPayload,
      signal,
      initiatorOverride,
    )

    if (isChatCompletionResponse(result.response)) {
      return {
        accountId: result.accountId,
        response: translateChatCompletionToResponses(result.response, payload),
      }
    }

    return {
      accountId: result.accountId,
      response: translateChatCompletionsStreamToResponses(
        result.response,
        payload,
      ),
    }
  }

  if (!account.copilotToken) {
    throw new Error("Copilot token not found")
  }

  const enableVision = hasVisionInput(payload)
  const initiator =
    initiatorOverride ?? inferInitiatorFromResponsesPayload(payload)

  const doRequest = async (requestAccount: typeof account) => {
    const headers: Record<string, string> = {
      ...copilotHeaders(requestAccount, enableVision),
      "editor-version": `vscode/${state.vsCodeVersion}`,
      "X-Initiator": initiator,
    }

    return fetch(`${copilotBaseUrl(state)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    })
  }

  const { account: usedAccount, response } =
    await executeCopilotRequestWithRetry({
      account,
      model: payload.model,
      doRequest,
    })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    throw new HTTPError("Failed to create responses", response, errorBody)
  }

  if (payload.stream) {
    return {
      accountId: usedAccount.id,
      response: events(
        response,
      ) as unknown as AsyncIterable<CopilotStreamEventLike>,
    }
  }

  return {
    accountId: usedAccount.id,
    response: (await response.json()) as ResponsesResponse,
  }
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
