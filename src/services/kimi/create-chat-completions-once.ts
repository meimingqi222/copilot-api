import { randomUUID } from "node:crypto"

import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import { canonicalNativeModelId, isOAuthAccount } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { isChatCompletionResponse } from "~/lib/utils"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
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
  account: Account,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  if (!isOAuthAccount(account) || account.provider !== "kimi") {
    throw new Error(`Kimi chat requires a Kimi OAuth account`)
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(`Kimi access token missing for account "${account.label}"`)
  }

  const model = canonicalNativeModelId(payload.model)
  const upstreamModel = stripKimiModelPrefix(model)
  const requestBody = {
    ...payload,
    model: upstreamModel,
  }

  const response = await fetchWithOAuthProxy(account, KIMI_CHAT_URL, {
    method: "POST",
    headers: buildKimiHeaders(account, accessToken, payload.stream === true),
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
