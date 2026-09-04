import { HTTPError } from "~/lib/error"
import {
  isAccountManagedConnection,
  isConnectionAvailable,
  listProviderConnections,
  refreshConnectionAvailability,
} from "~/lib/provider-connections"

import type { Account } from "./accounts"

import { getAccountAvailability } from "./account-availability"
import { getAccount, listAccounts } from "./accounts"

/**
 * 计算 cooldown / quota 凭据的最小剩余退避时间(秒)。
 * quota 也纳入计算 — `getAccountAvailability` 已为 quota_exhausted 返回
 * 基于 quotaExhaustedAt + 自动恢复窗口的剩余时间。
 */
function getMinimumRetryAfterSeconds(
  accounts: Array<Account> = listAccounts(),
): number {
  let minRetryAfter = 0
  for (const account of accounts) {
    const availability = getAccountAvailability(account)
    if (
      (availability.reason !== "cooldown" && availability.reason !== "quota")
      || availability.retryAfterSeconds <= 0
    ) {
      continue
    }
    if (minRetryAfter === 0 || availability.retryAfterSeconds < minRetryAfter) {
      minRetryAfter = availability.retryAfterSeconds
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
 *
 * 此处 `getActiveAccount` 用于 `/v1/models`、`/token` 等内部路由,无 endpoint
 * 协议信息,统一用 OpenAI 风格 error body(`rate_limit_exceeded` 或
 * `insufficient_quota`)。主流 chat/messages 路径的错误构造在
 * `prepareRequestAdmission` 中按 endpoint 区分。
 */
function buildRateLimitedResponse(
  reason: "cooldown" | "quota",
  message: string,
  accounts: Array<Account> = listAccounts(),
): Response {
  const retryAfterSeconds = getMinimumRetryAfterSeconds(accounts)
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
 * Phase 5:getActiveAccount 从首个启用的 account-managed connection 派生
 * Account 快照。完全 connection 原生,不再有 legacy fallback。
 *
 * 用于 `/v1/models`、`/token` 等内部路由,无 endpoint 协议信息。
 */
export function getActiveAccount(): Account {
  const connection = getFirstAvailableAccountManagedConnection()
  if (connection) {
    const account = getAccount(connection.id)
    if (account) return account
  }

  // getFirstAvailableAccountManagedConnection 已对 cooldown/quota 抛出
  // HTTPError;到达此处意味着无 account-managed connection。
  throw new HTTPError(
    "No available accounts (all disabled or no accounts configured)",
    new Response("Service Unavailable", { status: 503 }),
  )
}

/**
 * 从 stateRoot.connections 中找出首个可用的 account-managed connection
 * (按 priority 升序、同 priority 保持原始顺序)。
 *
 * Phase 1.7:导出供 token.ts / get-models.ts / /token 路由等内部入口
 * 直接使用 connection,不再经由 getActiveAccount() → Account 快照 →
 * 桥接反查 connection 的绕路。
 */
export function getFirstAvailableAccountManagedConnection() {
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

  // 无可用 connection — 构造与 legacy 路径一致的错误响应
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
      ),
    )
  }

  return undefined
}
