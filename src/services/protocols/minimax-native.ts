/**
 * MiniMax Code Native Protocol Adapter。
 *
 * MiniMax Code（订阅制）的模型面就是 Anthropic Messages 协议：
 *
 *   POST {agent}/mavis/api/v1/llm/v1/messages
 *     authorization: Bearer <accessToken>   ← 只认 Bearer，`x-api-key` 会 401
 *     anthropic-version: 2023-06-01
 *
 * 所以这里不做任何翻译：请求体已经是 Anthropic Messages 形状（`/v1/messages`
 * 路径下），响应也是标准 Messages SSE / JSON，只需按 MiniMax 的地址与鉴权发出去。
 * 上游地址从 `connection.baseUrl` 取（登录时写入，自带区域），因此同一个
 * adapter 同时服务国内版与国际版。
 *
 * `GET /v1/models` 对订阅流量是 503（`direct_route_not_configured`），
 * 模型列表优先取 models.dev 的 `minimax-*-coding-plan` 条目，
 * 内嵌 MINIMAX_CATALOG 兜底（见 services/oauth/model-catalog.ts），
 * 这里刻意不实现 discoverModels。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import {
  buildBaseHeaders,
  connectionFetchInit,
  detectAnthropicStreamError,
  handleUpstreamFailure,
  joinUrl,
  safeSseStream,
  setHeader,
} from "~/services/protocols/shared"
import {
  MINIMAX_USER_AGENT,
  minimaxMessagesBaseUrl,
  resolveMinimaxRegion,
} from "~/services/oauth/minimax"

import type { AdapterMessagesResult, ProtocolAdapter } from "./types"

/** MiniMax 的 Messages baseUrl（`.../llm/v1`），缺失时按 region 兜底。 */
function resolveMinimaxBaseUrl(connection: ProviderConnection): string {
  const configured = connection.baseUrl?.trim()
  if (configured) return configured
  return minimaxMessagesBaseUrl(resolveMinimaxRegion(connection))
}

export const minimaxNativeAdapter: ProtocolAdapter = {
  protocol: "minimax-native",

  async createMessages({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
    const forwardedHeaders = ctx?.forwardedHeaders ?? {}
    const headers = buildBaseHeaders(connection, credential)
    // MiniMax 的 Messages 端点**只**认 `authorization: Bearer`：其余写法
    // （`x-api-key`、裸 token）实测都被 401 拒。所以这里不看 credential.authMode，
    // 直接把值当 bearer 发——导入/手工建的 connection 也因此能用。
    if (credential.value) {
      setHeader(headers, "Authorization", `Bearer ${credential.value}`)
    }
    setHeader(
      headers,
      "anthropic-version",
      forwardedHeaders["anthropic-version"] ?? "2023-06-01",
    )
    setHeader(headers, "user-agent", MINIMAX_USER_AGENT)

    const upstreamPayload = {
      ...payload,
      model: target.upstreamModelId,
    }
    const isStream = Boolean(payload.stream)

    const response = await fetch(
      joinUrl(resolveMinimaxBaseUrl(connection), "/messages"),
      connectionFetchInit(connection, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamPayload),
        signal,
      }),
    )
    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create messages",
        "minimax-native",
      )
    }

    if (isStream) {
      const stream = await safeSseStream(response, detectAnthropicStreamError)
      return {
        credentialId: credential.id,
        response: stream as unknown as AsyncIterable<unknown>,
      } satisfies AdapterMessagesResult
    }

    const body = (await response.json()) as Record<string, unknown>
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterMessagesResult
  },
}
