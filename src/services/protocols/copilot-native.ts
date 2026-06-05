/**
 * Copilot Native Protocol Adapter。
 *
 * 把 legacy Copilot Account 路径(Responses API / Chat Completions / Messages /
 * Embeddings)封装为 ProtocolAdapter,使 executeWithFailover 统一调度。
 */

import type { Account, CopilotAccount } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { EmbeddingResponse } from "~/services/copilot/create-embeddings"
import type { ProtocolAdapter } from "~/services/protocols/types"

import { getCopilotToken, parseModelReference } from "~/lib/accounts"
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { translateToCopilotMessages } from "~/services/copilot/create-messages"
import {
  shouldUseResponsesApi,
  translateResponsesStreamToChatCompletions,
  translateResponsesToChatCompletion,
  translateToResponsesPayload,
} from "~/services/copilot/responses-api"
import {
  detectAnthropicStreamError,
  detectOpenAIStreamError,
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("copilot-native adapter: target.account is required")
  }
  return account
}

function hasImageContent(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    (message) =>
      typeof message.content !== "string"
      && message.content?.some((content) => content.type === "image_url"),
  )
}

function hasAnthropicImageContent(
  messages: Array<{ content: unknown }>,
): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some(
        (block: { type?: string }) => block.type === "image",
      ),
  )
}

export const copilotNativeAdapter: ProtocolAdapter = {
  protocol: "copilot-native",

  // eslint-disable-next-line max-params
  async createChatCompletions(
    target,
    _connection,
    _credential,
    payload,
    signal,
    ctx,
  ) {
    const account = extractAccount(target)
    const copilotAccount = account as CopilotAccount
    if (!getCopilotToken(copilotAccount)) {
      throw new Error("Copilot token not found")
    }

    const normalizedPayload: ChatCompletionsPayload = {
      ...payload,
      model: parseModelReference(payload.model).nativeModelId,
    }
    const useResponsesApi = shouldUseResponsesApi(
      normalizedPayload.model,
      copilotAccount,
    )
    const enableVision = ctx?.enableVision ?? hasImageContent(normalizedPayload)

    const chatCompletionsBody = JSON.stringify(normalizedPayload)
    const responsesBody =
      useResponsesApi ?
        JSON.stringify(translateToResponsesPayload(normalizedPayload))
      : ""

    const headers: Record<string, string> = {
      ...copilotHeaders(copilotAccount, enableVision),
      "editor-version": `vscode/${state.vsCodeVersion}`,
    }
    if (ctx?.initiator) {
      headers["X-Initiator"] = ctx.initiator
    }

    const response = await fetch(
      `${copilotBaseUrl(state)}${useResponsesApi ? "/responses" : "/chat/completions"}`,
      {
        method: "POST",
        headers,
        body: useResponsesApi ? responsesBody : chatCompletionsBody,
        signal,
      },
    )

    if (response.status === 429) {
      const errorBody = await response.text().catch(() => "(unreadable)")
      throw new HTTPError(
        "Failed to create chat completions",
        response,
        errorBody,
      )
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "(unreadable)")
      throw new HTTPError(
        "Failed to create chat completions",
        response,
        errorBody,
      )
    }

    if (normalizedPayload.stream) {
      if (useResponsesApi) {
        const rawStream = (await safeSseStream(
          response,
          detectResponsesStreamError,
        )) as unknown as AsyncIterable<CopilotStreamEvent>
        return {
          credentialId: account.id,
          response: translateResponsesStreamToChatCompletions(
            rawStream,
            normalizedPayload.model,
          ) as AsyncIterable<CopilotStreamEvent>,
        }
      }
      const stream = (await safeSseStream(
        response,
        detectOpenAIStreamError,
      )) as unknown as AsyncIterable<CopilotStreamEvent>
      return {
        credentialId: account.id,
        response: stream,
      }
    }

    const responseBody = await response.json()
    return {
      credentialId: account.id,
      response:
        useResponsesApi ?
          translateResponsesToChatCompletion(
            responseBody as Parameters<
              typeof translateResponsesToChatCompletion
            >[0],
          )
        : (responseBody as ChatCompletionResponse),
    }
  },

  // eslint-disable-next-line max-params
  async createMessages(target, _connection, _credential, payload, signal, ctx) {
    const account = extractAccount(target)
    const copilotAccount = account as CopilotAccount
    if (!getCopilotToken(copilotAccount)) {
      throw new Error("Copilot token not found")
    }

    const anthropicPayload =
      payload as unknown as import("~/routes/messages/anthropic-types").AnthropicMessagesPayload
    const enableVision =
      ctx?.enableVision ?? hasAnthropicImageContent(anthropicPayload.messages)

    const copilotPayload = translateToCopilotMessages(anthropicPayload)
    const headers: Record<string, string> = {
      ...copilotHeaders(copilotAccount, enableVision),
      "editor-version": `vscode/${state.vsCodeVersion}`,
    }
    if (ctx?.initiator) {
      headers["X-Initiator"] = ctx.initiator
    }

    const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(copilotPayload),
      signal,
    })

    if (response.status === 429) {
      const errorBody = await response.text().catch(() => "(unreadable)")
      throw new HTTPError("Failed to create messages", response, errorBody)
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "(unreadable)")
      throw new HTTPError("Failed to create messages", response, errorBody)
    }

    if (anthropicPayload.stream) {
      const stream = await safeSseStream(
        response,
        detectAnthropicStreamError,
      )
      return {
        credentialId: account.id,
        response: stream as unknown as AsyncIterable<unknown>,
      }
    }

    return {
      credentialId: account.id,
      response: (await response.json()) as Record<string, unknown>,
    }
  },

  async createEmbeddings(target, _connection, _credential, payload, signal) {
    const account = extractAccount(target)
    const copilotAccount = account as CopilotAccount
    if (!getCopilotToken(copilotAccount)) {
      throw new Error("Copilot token not found")
    }

    const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
      method: "POST",
      headers: copilotHeaders(copilotAccount),
      body: JSON.stringify({
        ...payload,
        model: parseModelReference(payload.model).nativeModelId,
      }),
      signal,
    })

    if (response.status === 429) {
      throw new HTTPError("Failed to create embeddings", response)
    }

    if (!response.ok) {
      throw new HTTPError("Failed to create embeddings", response)
    }

    return {
      credentialId: account.id,
      response: (await response.json()) as EmbeddingResponse,
    }
  },
}
