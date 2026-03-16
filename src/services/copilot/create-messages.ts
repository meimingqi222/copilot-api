import { events } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

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

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  signal?: AbortSignal,
  options?: {
    forwardedHeaders?: {
      anthropicBeta?: string
      anthropicVersion?: string
    }
    initiatorOverride?: "agent" | "user"
  },
): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEventLike> }
  | { accountId: string; response: AnthropicResponse }
> => {
  const account = getAccountForModel(payload.model)
  if (!account.copilotToken) {
    throw new Error("Copilot token not found")
  }

  const enableVision = payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((block) => block.type === "image"),
  )
  const initiator =
    options?.initiatorOverride ?? inferMessagesInitiator(payload)

  const doRequest = async (requestAccount: typeof account) => {
    const headers: Record<string, string> = {
      ...copilotHeaders(requestAccount, enableVision),
      "editor-version": `vscode/${state.vsCodeVersion}`,
      "X-Initiator": initiator,
      ...(options?.forwardedHeaders?.anthropicBeta ?
        {
          "anthropic-beta": options.forwardedHeaders.anthropicBeta,
        }
      : {}),
      ...(options?.forwardedHeaders?.anthropicVersion ?
        {
          "anthropic-version": options.forwardedHeaders.anthropicVersion,
        }
      : {}),
    }

    return fetch(`${copilotBaseUrl(state)}/v1/messages`, {
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
    throw new HTTPError("Failed to create messages", response, errorBody)
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
    response: (await response.json()) as AnthropicResponse,
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

function inferMessagesInitiator(
  payload: AnthropicMessagesPayload,
): "agent" | "user" {
  const lastMessage = payload.messages.at(-1)
  if (!lastMessage) {
    return "user"
  }

  if (lastMessage.role === "assistant") {
    return "agent"
  }

  if (
    Array.isArray(lastMessage.content)
    && lastMessage.content.some((block) => block.type === "tool_result")
  ) {
    return "agent"
  }

  return "user"
}
