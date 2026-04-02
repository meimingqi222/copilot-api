import { events } from "fetch-event-stream"

import type {
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
} from "~/routes/messages/anthropic-types"
import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import { getAccountForModel } from "~/lib/accounts"
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { inferInitiatorFromAnthropicPayload } from "~/services/copilot/initiator"
import { executeCopilotRequestWithRetry } from "~/services/copilot/request"

/**
 * Copilot's /v1/messages endpoint does not support image blocks nested inside
 * tool_result content arrays.  This function moves any such images to the
 * top-level content of the surrounding user message so the endpoint can
 * process them as regular vision inputs.
 *
 * Before:
 *   user.content = [
 *     { type: "tool_result", content: [{ type: "image", source: … }] }
 *   ]
 *
 * After:
 *   user.content = [
 *     { type: "tool_result", content: "[See attached image]" },
 *     { type: "image", source: … }
 *   ]
 */
function hoistToolResultImages(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      return message
    }

    const processedContent: typeof message.content = []
    const hoistedImages: Array<AnthropicImageBlock> = []

    for (const block of message.content) {
      if (
        block.type === "tool_result"
        && Array.isArray(block.content)
        && block.content.some((c) => c.type === "image")
      ) {
        const textContent = block.content
          .filter((c): c is AnthropicTextBlock => c.type === "text")
          .map((c) => c.text)
          .join("\n")
        const images = block.content.filter(
          (c): c is AnthropicImageBlock => c.type === "image",
        )

        const newBlock: AnthropicToolResultBlock = {
          ...block,
          content: textContent || "[See attached image from tool result]",
        }
        processedContent.push(newBlock)
        hoistedImages.push(...images)
      } else {
        processedContent.push(block)
      }
    }

    if (hoistedImages.length === 0) {
      return message
    }

    return {
      ...message,
      content: [...processedContent, ...hoistedImages],
    }
  })
}

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
    messages: hoistToolResultImages(rest.messages),
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

  // hoist is also applied in translateToCopilotMessages; run it here first so
  // enableVision correctly detects images that were originally in tool_results.
  const hoistedMessages = hoistToolResultImages(payload.messages)
  const enableVision = hoistedMessages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((block) => block.type === "image"),
  )
  const initiator =
    options?.initiatorOverride ?? inferInitiatorFromAnthropicPayload(payload)

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

  const { account: usedAccount, response } =
    await executeCopilotRequestWithRetry({
      account,
      model: payload.model,
      doRequest,
    })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    throw new HTTPError("Failed to create messages", response, errorBody)
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
    response: (await response.json()) as AnthropicResponse,
  }
}
