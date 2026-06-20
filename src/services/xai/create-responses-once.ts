import type { Account } from "~/lib/accounts"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { canonicalNativeModelId, isOAuthAccount } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import { XAI_API_BASE_URL } from "~/services/oauth/xai"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { collectResponsesFromSseResponse } from "~/services/responses/sse-collector"

import { buildXaiHeaders } from "./headers"

function resolveXaiSessionId(payload: ResponsesPayload): string | undefined {
  const cacheKey = payload.metadata?.prompt_cache_key
  return typeof cacheKey === "string" ? cacheKey : undefined
}

export async function createXaiResponsesOnce(
  account: Account,
  payload: ResponsesPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  if (!isOAuthAccount(account) || account.provider !== "xai") {
    throw new Error("xAI responses requires an xAI OAuth account")
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(`xAI access token missing for account "${account.label}"`)
  }

  const model = canonicalNativeModelId(payload.model)
  const baseUrl = account.settings?.baseUrl ?? XAI_API_BASE_URL
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`
  const clientStream = payload.stream === true
  const sessionId = resolveXaiSessionId(payload)

  const upstreamBody = {
    ...payload,
    model,
    stream: true,
    previous_response_id: undefined,
    prompt_cache_retention: undefined,
    safety_identifier: undefined,
    stream_options: undefined,
  }

  const response = await fetchWithOAuthProxy(account, url, {
    method: "POST",
    headers: buildXaiHeaders(accessToken, true, sessionId),
    body: JSON.stringify(upstreamBody),
    signal,
  })

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create xAI responses",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  if (clientStream) {
    const stream = await safeSseStream(response, detectResponsesStreamError)
    return normalizeResponsesStreamIds(
      stream as unknown as AsyncIterable<CopilotStreamEventLike>,
    )
  }

  return collectResponsesFromSseResponse(response, model)
}
