import type { Account } from "~/lib/accounts"

import {
  getAccountAvailability,
  isAccountAvailable,
  refreshAccountRuntimeAvailability,
} from "~/lib/account-availability"
import { listAccounts } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"

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

function refreshAllAccountAvailability(): void {
  for (const account of listAccounts()) {
    refreshAccountRuntimeAvailability(account)
  }
}

function sortAccounts(accounts: Array<Account>): Array<Account> {
  return accounts
    .map((account, originalIndex) => ({ account, originalIndex }))
    .sort((left, right) => {
      const leftPriority = left.account.priority
      const rightPriority = right.account.priority
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority
      }
      return left.originalIndex - right.originalIndex
    })
    .map((item) => item.account)
}

function getSortedAvailableAccounts(): Array<Account> {
  return sortAccounts(
    listAccounts().filter((account) => isAccountAvailable(account)),
  )
}

export function getActiveAccount(): Account {
  refreshAllAccountAvailability()

  const available = getSortedAvailableAccounts()

  if (available.length > 0) {
    return available[0]
  }

  const allAccounts = listAccounts()
  const hasCooldownAccounts = allAccounts.some(
    (account) =>
      account.enabled && getAccountAvailability(account).reason === "cooldown",
  )
  if (hasCooldownAccounts) {
    throw new HTTPError(
      "All accounts are temporarily unavailable due to rate limiting",
      buildRateLimitedResponse(
        "cooldown",
        "All accounts are temporarily unavailable due to rate limiting",
      ),
    )
  }

  const hasQuotaExhaustedAccounts = allAccounts.some(
    (account) =>
      account.enabled && getAccountAvailability(account).reason === "quota",
  )
  if (hasQuotaExhaustedAccounts) {
    throw new HTTPError(
      "All accounts are unavailable due to quota exhaustion",
      buildRateLimitedResponse(
        "quota",
        "All accounts are unavailable due to quota exhaustion",
      ),
    )
  }

  throw new HTTPError(
    "No available accounts (all disabled or no accounts configured)",
    new Response("Service Unavailable", { status: 503 }),
  )
}
