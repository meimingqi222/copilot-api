/**
 * xAI 媒体端点（图片/视频）共用的请求骨架：取 token → 拼头 → 走连接代理 →
 * 失败统一记日志并抛 HTTPError。各端点只提供 URL、body 与日志/错误文案。
 */
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { serializeUpstreamBody } from "~/lib/upstream-performance"

import { requireXaiAccessToken } from "./access"
import { buildXaiHeaders } from "./headers"

export async function xaiMediaRequest<T>(input: {
  connection: ProviderConnection
  credential: ApiCredential
  url: string
  method?: "GET" | "POST"
  body?: Record<string, unknown>
  signal?: AbortSignal
  idempotencyKey?: string
  /** 日志里的动作名，如 "image generation" / "video retrieval"。 */
  logLabel: string
  /** 日志里区分具体对象，如 `model "grok-image"`、`request "abc"`。 */
  logSubject: string
  failureMessage: string
}): Promise<T> {
  const accessToken = await requireXaiAccessToken(
    input.connection,
    input.credential,
  )
  const headers = buildXaiHeaders(
    accessToken,
    false,
    undefined,
    false,
    input.connection.headers,
  )
  if (input.idempotencyKey) {
    headers["x-idempotency-key"] = input.idempotencyKey
  }

  const response = await fetchWithConnectionProxy(input.connection, input.url, {
    method: input.method ?? "POST",
    headers,
    ...(input.body ? { body: serializeUpstreamBody(input.body) } : {}),
    signal: input.signal,
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "(unreadable)")
    logger.warn(
      `xAI ${input.logLabel} failed for connection "${input.connection.name}" ${input.logSubject}: ${response.status} ${response.statusText}`,
    )
    throw new HTTPError(input.failureMessage, response, bodyText)
  }

  return (await response.json()) as T
}
