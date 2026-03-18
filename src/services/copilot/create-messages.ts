import { events } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import {
  getAccountForModel,
  markAccountExhausted,
  tryNextAccountForModel,
} from "~/lib/accounts"
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  reportUpstreamRateLimit,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"
import { state } from "~/lib/state"

/**
 * Translates Anthropic messages payload to Copilot's /v1/messages format.
 * reasoning_effort is an OpenAI-specific parameter and should not be sent to
 * Copilot's Anthropic-compatible /v1/messages endpoint.
 * thinking is Anthropic's native parameter and should be preserved.
 */
export function translateToCopilotMessages(
  payload: AnthropicMessagesPayload,
): Record<string, unknown> {
  const { reasoning_effort: _, ...rest } = payload

  return {
    ...rest,
    ...(payload.stream !== undefined ? { stream: payload.stream } : {}),
    ...(payload.temperature !== undefined ?
      { temperature: payload.temperature }
    : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.top_k !== undefined ? { top_k: payload.top_k } : {}),
    ...(payload.tools ? { tools: payload.tools } : {}),
    ...(payload.tool_choice ? { tool_choice: payload.tool_choice } : {}),
    ...(payload.service_tier ? { service_tier: payload.service_tier } : {}),
  }
}

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

  // Strip reasoning_effort and thinking - OpenAI-specific params not supported by Copilot's Anthropic endpoint
  const copilotPayload = translateToCopilotMessages(payload)

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
      body: JSON.stringify(copilotPayload),
      signal,
    })
  }

  let usedAccount = account
  let response = await doRequest(account)

  if (!response.ok && response.status === 429) {
    await reportUpstreamRateLimit(account.id, response)
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

  await reportUpstreamSuccess(usedAccount.id)

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
