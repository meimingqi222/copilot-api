import { randomUUID } from "node:crypto"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import { HTTPError } from "~/lib/error"
import { canonicalNativeModelId } from "~/lib/legacy-accounts"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { isChatCompletionResponse } from "~/lib/utils"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import { stripKimiModelPrefix } from "~/services/oauth/kimi"
import {
  detectOpenAIStreamError,
  safeSseStream,
} from "~/services/protocols/shared"

import { buildKimiHeaders } from "./headers"

const KIMI_CHAT_URL = "https://api.kimi.com/coding/v1/chat/completions"

async function* openAiSseToCopilotEvents(
  stream: AsyncIterable<{ event?: string; data?: string }>,
  model: string,
): AsyncIterable<CopilotStreamEvent> {
  const requestId = `chatcmpl-${randomUUID().replaceAll("-", "")}`
  for await (const event of stream) {
    if (!event.data || event.data === "[DONE]") {
      if (event.data === "[DONE]") {
        yield { data: "[DONE]" }
      }
      continue
    }
    yield { data: event.data }
  }
  void requestId
  void model
}

export async function createKimiChatCompletionsOnce(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  if (connection.protocol !== "kimi-native") {
    throw new Error(`Kimi chat requires a Kimi OAuth connection`)
  }

  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `Kimi access token missing for connection "${connection.name}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  const upstreamModel = stripKimiModelPrefix(model)
  const requestBody = {
    ...payload,
    model: upstreamModel,
  }

  const response = await fetchWithConnectionProxy(connection, KIMI_CHAT_URL, {
    method: "POST",
    headers: buildKimiHeaders(connection, accessToken, payload.stream === true),
    body: JSON.stringify(requestBody),
    signal,
  })

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Kimi chat completion",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  if (payload.stream) {
    const stream = await safeSseStream(response, detectOpenAIStreamError)
    return openAiSseToCopilotEvents(stream, model)
  }

  const body = (await response.json()) as ChatCompletionResponse
  if (!isChatCompletionResponse(body)) {
    throw new Error("Kimi upstream returned invalid chat completion response")
  }
  return body
}
