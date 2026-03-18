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

/**
 * Translates Anthropic thinking config to Copilot's /v1/messages format.
 * Copilot's /v1/messages endpoint uses reasoning_effort instead of budget_tokens.
 * Budget mapping:
 * - minimal: budget < 1024
 * - low: 1024 <= budget < 8192
 * - medium: 8192 <= budget < 24576
 * - high: 24576 <= budget < 32768
 * - xhigh: budget >= 32768
 */
function translateThinkingToReasoningEffort(
  thinking: AnthropicMessagesPayload["thinking"],
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!thinking) {
    return undefined
  }

  if (thinking.type === "enabled") {
    const budget = thinking.budget_tokens ?? 8192
    if (budget >= 32768) return "xhigh"
    if (budget >= 24576) return "high"
    if (budget >= 8192) return "medium"
    if (budget >= 1024) return "low"
    return "minimal"
  }

  // adaptive: let the model decide, default to high
  return "high"
}

/**
 * Translates Anthropic messages payload to Copilot's /v1/messages format.
 * The main difference is that Copilot uses reasoning_effort instead of thinking.budget_tokens.
 */
export function translateToCopilotMessages(
  payload: AnthropicMessagesPayload,
): Record<string, unknown> {
  const reasoningEffort = translateThinkingToReasoningEffort(payload.thinking)

  return {
    model: payload.model,
    messages: payload.messages,
    max_tokens: payload.max_tokens,
    ...(payload.system ? { system: payload.system } : {}),
    ...(payload.metadata ? { metadata: payload.metadata } : {}),
    ...(payload.stop_sequences ? { stop_sequences: payload.stop_sequences } : {}),
    ...(payload.stream !== undefined ? { stream: payload.stream } : {}),
    // Copilot requires temperature=1 when reasoning is enabled
    ...(reasoningEffort !== undefined
      ? { temperature: 1, reasoning_effort: reasoningEffort }
      : payload.temperature !== undefined
        ? { temperature: payload.temperature }
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

  // Translate thinking to reasoning_effort for Copilot's /v1/messages endpoint
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
