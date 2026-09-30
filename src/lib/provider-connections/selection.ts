/**
 * account-managed connection 的可用性选择。
 *
 * 供 `/v1/models`、`/token` 等无 endpoint 协议信息的内部路由使用:
 * 按 priority 升序取首个可调度的 account-managed connection。
 * 全部不可用时抛 HTTPError——cooldown/quota 附 429 + 退避 headers。
 */
import { HTTPError } from "~/lib/error"

import {
  getConnectionRoutability,
  isConnectionAvailable,
  refreshConnectionAvailability,
} from "./availability"
import { isAccountManagedConnection } from "./account-managed"
import { listProviderConnections } from "./state"
import type { ProviderConnection } from "./types"

/**
 * 计算 cooldown / quota 凭据的最小剩余退避时间(秒)。
 * 客户端据此退避,避免立即重试导致雪崩。
 */
function getMinimumRetryAfterSeconds(
  connections: Array<ProviderConnection>,
): number {
  let minRetryAfter = 0
  for (const connection of connections) {
    const { reason, retryAfterSeconds } = getConnectionRoutability(connection)
    if (
      (reason !== "cooldown" && reason !== "quota_exhausted")
      || retryAfterSeconds <= 0
    ) {
      continue
    }
    if (minRetryAfter === 0 || retryAfterSeconds < minRetryAfter) {
      minRetryAfter = retryAfterSeconds
    }
  }
  return minRetryAfter
}

/**
 * 构造 429 限流响应,返回 OpenAI 风格 JSON 错误体 + 3 个退避 headers。
 *
 * - `Retry-After`:HTTP 标准,秒。所有 SDK 默认读取。
 * - `retry-after-ms`:Anthropic 风格,毫秒。oh-my-pi 等客户端优先读取。
 * - `x-ratelimit-reset`:OpenAI 风格,秒。oh-my-pi 等客户端作为补充信号。
 */
function buildRateLimitedResponse(
  reason: "cooldown" | "quota",
  message: string,
  connections: Array<ProviderConnection>,
): Response {
  const retryAfterSeconds = getMinimumRetryAfterSeconds(connections)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (retryAfterSeconds > 0) {
    headers["Retry-After"] = String(retryAfterSeconds)
    headers["retry-after-ms"] = String(retryAfterSeconds * 1000)
    headers["x-ratelimit-reset"] = String(retryAfterSeconds)
  }
  const code = reason === "quota" ? "insufficient_quota" : "rate_limit_exceeded"
  const body = JSON.stringify({
    error: {
      message,
      type: code,
      param: null,
      code,
    },
  })
  return new Response(body, { status: 429, headers })
}

/**
 * 从 stateRoot.connections 中找出首个可用的 account-managed connection
 * (按 priority 升序、同 priority 保持原始顺序)。
 *
 * 无可用连接且存在 cooldown/quota 时抛 HTTPError(429 + 退避 headers);
 * 全无 account-managed connection 时返回 undefined。
 */
export function getFirstAvailableAccountManagedConnection():
  | ProviderConnection
  | undefined {
  const candidates = listProviderConnections()
    .filter((conn) => isAccountManagedConnection(conn))
    .map((conn, originalIndex) => ({ conn, originalIndex }))
    .sort((left, right) => {
      const leftPriority = left.conn.priority
      const rightPriority = right.conn.priority
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority
      }
      return left.originalIndex - right.originalIndex
    })
    .map((item) => item.conn)

  // 先 refresh availability(把已过期的 cooldown / quota_exhausted 恢复)
  for (const conn of candidates) {
    refreshConnectionAvailability(conn)
  }

  const available = candidates.find((conn) => isConnectionAvailable(conn))
  if (available) return available

  const hasCooldown = candidates.some(
    (conn) =>
      conn.enabled && conn.credentials.some((c) => c.status === "cooldown"),
  )
  if (hasCooldown) {
    throw new HTTPError(
      "All accounts are temporarily unavailable due to rate limiting",
      buildRateLimitedResponse(
        "cooldown",
        "All accounts are temporarily unavailable due to rate limiting",
        candidates,
      ),
    )
  }

  const hasQuotaExhausted = candidates.some(
    (conn) =>
      conn.enabled
      && conn.credentials.some((c) => c.status === "quota_exhausted"),
  )
  if (hasQuotaExhausted) {
    throw new HTTPError(
      "All accounts are unavailable due to quota exhaustion",
      buildRateLimitedResponse(
        "quota",
        "All accounts are unavailable due to quota exhaustion",
        candidates,
      ),
    )
  }

  return undefined
}
