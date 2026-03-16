import { events } from "fetch-event-stream"

import {
  getAccountForModel,
  markAccountExhausted,
  switchToNextAccountForModel,
} from "~/lib/accounts"
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  reportUpstreamRateLimit,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
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
  if (!account.copilotToken) {
    throw new Error("Copilot token not found")
  }

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

  const enableVision = hasVisionInput(payload)
  const initiator = initiatorOverride ?? inferResponsesInitiator(payload)

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

  let usedAccount = account
  let response = await doRequest(account)

  if (!response.ok && response.status === 429) {
    await reportUpstreamRateLimit(response)
    markAccountExhausted(account.id)
    const retryResult = await tryNextAccountForModel(
      account,
      payload.model,
      doRequest,
    )
    response = retryResult.response
    usedAccount = retryResult.account
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    throw new HTTPError("Failed to create responses", response, errorBody)
  }

  await reportUpstreamSuccess()

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

async function tryNextAccountForModel(
  currentAccount: Awaited<ReturnType<typeof getAccountForModel>>,
  modelId: string,
  doRequest: (
    account: Awaited<ReturnType<typeof getAccountForModel>>,
  ) => Promise<Response>,
): Promise<{
  response: Response
  account: Awaited<ReturnType<typeof getAccountForModel>>
}> {
  const nextAccount = switchToNextAccountForModel(currentAccount, modelId)
  if (nextAccount) {
    const retryResponse = await doRequest(nextAccount)
    if (!retryResponse.ok && retryResponse.status === 429) {
      await reportUpstreamRateLimit(retryResponse)
      markAccountExhausted(nextAccount.id)
    }
    return { response: retryResponse, account: nextAccount }
  }

  return {
    response: new Response("All accounts exhausted", { status: 429 }),
    account: currentAccount,
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

function inferResponsesInitiator(payload: ResponsesPayload): "agent" | "user" {
  if (typeof payload.input === "string") {
    return "user"
  }

  const lastInput = payload.input.at(-1)

  if (!lastInput) {
    return "user"
  }

  if ("role" in lastInput) {
    return lastInput.role === "assistant" ? "agent" : "user"
  }

  return "agent"
}

function isChatCompletionResponse(
  response: AsyncIterable<CopilotStreamEventLike> | ChatCompletionResponse,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}
