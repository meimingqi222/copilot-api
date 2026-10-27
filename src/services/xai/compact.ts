import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { serializeUpstreamBody } from "~/lib/upstream-performance"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import { resolveXaiModelId } from "~/services/oauth/model-catalog"
import { stripCompactionTrigger } from "~/services/responses/compact"

import { xaiWsBaseUrl } from "./endpoint"
import { buildXaiHeaders } from "./headers"
import { sanitizeXaiResponsesBodyWithRefs } from "./sanitize-body"
import { resolveXaiSessionId } from "./session"
import { requireXaiAccessToken } from "./access"

/**
 * True when an upstream error indicates an invalidated xAI OAuth access token:
 * an HTTP 403 carrying the bad-credentials payload.
 */
export function isXaiBadCredentialsHttpError(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return false
  if (error.response.status !== 403) return false
  const body = `${error.responseBody} ${error.message}`
  return /unauthenticated:bad-credentials|could not be validated/i.test(body)
}

/**
 * xAI 上游 `/responses/compact` 一元调用（服务端上下文压缩）。
 */
export async function createXaiCompactOnce(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  body: Record<string, unknown>,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<ResponsesResponse> {
  if (connection.protocol !== "xai-native") {
    throw new Error("xAI compact requires an xAI OAuth connection")
  }

  const accessToken = await requireXaiAccessToken(connection, credential)

  const rawModel = body.model
  if (typeof rawModel !== "string" || !rawModel.trim()) {
    throw new HTTPError(
      "xAI compact request is missing model",
      new Response("Bad Request", { status: 400 }),
    )
  }
  const model = resolveXaiModelId(canonicalNativeModelId(rawModel))
  const officialBase = xaiWsBaseUrl(connection).replace(/\/+$/, "")
  const url = `${officialBase}/responses/compact`
  const sessionId = resolveXaiSessionId(
    body as unknown as ResponsesPayload,
    model,
    ctx,
  )

  const compactInput: Record<string, unknown> = {
    ...body,
    model,
    input: stripCompactionTrigger(body.input),
    stream: undefined,
    tools: undefined,
    max_output_tokens: undefined,
    temperature: undefined,
    top_p: undefined,
    top_k: undefined,
    stop: undefined,
    previous_response_id: undefined,
    stream_options: undefined,
    safety_identifier: undefined,
    prompt_cache_retention: undefined,
  }
  if (sessionId && !compactInput.prompt_cache_key) {
    compactInput.prompt_cache_key = sessionId
  }
  const upstreamBody = sanitizeXaiResponsesBodyWithRefs(
    compactInput,
    model,
  ).body

  logger.debug("[xai] compact upstream request", {
    model,
    inputItems:
      Array.isArray(upstreamBody.input) ? upstreamBody.input.length : 0,
  })
  const httpBody = serializeUpstreamBody(upstreamBody)
  let currentAccessToken = accessToken
  let response = await fetchWithConnectionProxy(connection, url, {
    method: "POST",
    headers: buildXaiHeaders(
      currentAccessToken,
      false,
      sessionId,
      false,
      connection.headers,
    ),
    body: httpBody,
    signal,
  })

  if (response.status === 403) {
    const errorBody = await response
      .clone()
      .text()
      .catch(() => "")
    if (
      /unauthenticated:bad-credentials|could not be validated/i.test(errorBody)
    ) {
      logger.warn(
        `xAI returned 403 bad-credentials for connection "${connection.name}". Forcing token refresh...`,
      )
      const refreshedToken = await ensureOAuthConnectionAccessToken(
        connection,
        credential,
        {
          forceRefresh: true,
          failedAccessToken: currentAccessToken,
        },
      )
      if (refreshedToken && refreshedToken !== currentAccessToken) {
        currentAccessToken = refreshedToken
        response = await fetchWithConnectionProxy(connection, url, {
          method: "POST",
          headers: buildXaiHeaders(
            currentAccessToken,
            false,
            sessionId,
            false,
            connection.headers,
          ),
          body: httpBody,
          signal,
        })
      }
    }
  }

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create xAI compact response",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }
  return (await response.json()) as ResponsesResponse
}
