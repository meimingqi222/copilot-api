import type { Account, AccountQuotaState } from "~/lib/accounts"

import { buildAccountDiagnosticSnapshot } from "~/lib/account-diagnostics"
import { saveAccounts } from "~/lib/account-store"
import { getAccount } from "~/lib/accounts"
import { logger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  syncAccountToConnection,
} from "~/lib/provider-connections"
import {
  getRemainingCooldownSeconds,
  reportUpstreamRateLimit,
  reportUpstreamRateLimitMs,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"

export function syncLegacyExhaustedState(account: Account): void {
  const remainingCooldown = getRemainingCooldownSeconds(account.id)
  const exhausted = remainingCooldown > 0 || account.quotaState === "exhausted"
  account.isExhausted = exhausted
  if (!exhausted) {
    account.exhaustedAt = undefined
    return
  }

  account.exhaustedAt =
    account.lastRateLimitAt ?? account.quotaExhaustedAt ?? account.exhaustedAt
}

export function refreshAccountRuntimeAvailability(account: Account): boolean {
  const remainingCooldown = getRemainingCooldownSeconds(account.id)
  if (remainingCooldown > 0) {
    account.cooldownUntil = Date.now() + remainingCooldown * 1000
    syncLegacyExhaustedState(account)
    return false
  }

  if (account.cooldownUntil && account.cooldownUntil < Date.now()) {
    account.cooldownUntil = undefined
    account.lastRateLimitReason = undefined
    syncLegacyExhaustedState(account)
    logger.info(
      `Account cooldown expired — re-activating: ${JSON.stringify(
        buildAccountDiagnosticSnapshot(account),
      )}`,
    )
    return true
  }

  syncLegacyExhaustedState(account)
  return false
}

export function getAccountAvailability(account: Account): {
  available: boolean
  reason: "available" | "disabled" | "cooldown" | "quota" | "error"
  retryAfterSeconds: number
} {
  refreshAccountRuntimeAvailability(account)

  if (!account.enabled) {
    return { available: false, reason: "disabled", retryAfterSeconds: 0 }
  }

  if (account.runtimeState?.authStatus === "error") {
    return { available: false, reason: "error", retryAfterSeconds: 10 }
  }

  const remainingCooldown = getRemainingCooldownSeconds(account.id)
  if (remainingCooldown > 0) {
    return {
      available: false,
      reason: "cooldown",
      retryAfterSeconds: remainingCooldown,
    }
  }

  if (account.quotaState === "exhausted") {
    return { available: false, reason: "quota", retryAfterSeconds: 0 }
  }

  return { available: true, reason: "available", retryAfterSeconds: 0 }
}

export function isAccountAvailable(account: Account): boolean {
  return getAccountAvailability(account).available
}

export function setAccountQuotaState(
  account: Account,
  quotaState: AccountQuotaState,
): void {
  account.quotaState = quotaState
  account.quotaExhaustedAt = quotaState === "exhausted" ? Date.now() : undefined
  syncLegacyExhaustedState(account)
}

export async function markAccountRateLimited(
  id: string,
  response: Response,
): Promise<void> {
  await reportUpstreamRateLimit(id, response)
  const account = getAccount(id)
  if (!account) return

  const status = response.status
  const remainingCooldown = getRemainingCooldownSeconds(id)
  account.lastRateLimitAt = Date.now()
  account.cooldownUntil =
    remainingCooldown > 0 ? Date.now() + remainingCooldown * 1000 : undefined
  account.lastRateLimitReason =
    status === 429 ? "upstream_429" : `upstream_${status}`
  syncLegacyExhaustedState(account)

  const conn = getMutableProviderConnection(account.id)
  if (conn) syncAccountToConnection(conn, account)
  saveAccounts().catch((err: unknown) => {
    logger.error("Failed to auto-save accounts after rate limit:", err)
  })

  const cooldownInfo =
    remainingCooldown > 0 ? ` (cooldown: ${remainingCooldown}s remaining)` : ""
  logger.warn(
    `Account "${account.label}" marked unavailable due to upstream rate limit${cooldownInfo}: ${JSON.stringify(
      buildAccountDiagnosticSnapshot(account),
    )}`,
  )
}

/**
 * Like `markAccountRateLimited` but accepts an explicit `retryAfterMs`
 * (parsed from a response body, e.g. Windsurf's "Resets in: 3h0m0s").
 * Used by the Windsurf path where the cooldown duration is in the message
 * body, not a Retry-After header.
 */
export async function markAccountRateLimitedMs(
  id: string,
  retryAfterMs?: number,
  reason = "upstream_windsurf_rate_limit",
): Promise<void> {
  await reportUpstreamRateLimitMs(id, retryAfterMs)
  const account = getAccount(id)
  if (!account) return

  const remainingCooldown = getRemainingCooldownSeconds(id)
  account.lastRateLimitAt = Date.now()
  account.cooldownUntil =
    remainingCooldown > 0 ? Date.now() + remainingCooldown * 1000 : undefined
  account.lastRateLimitReason = reason
  syncLegacyExhaustedState(account)

  const conn = getMutableProviderConnection(account.id)
  if (conn) syncAccountToConnection(conn, account)
  saveAccounts().catch((err: unknown) => {
    logger.error("Failed to auto-save accounts after rate limit:", err)
  })

  const cooldownInfo =
    remainingCooldown > 0 ? ` (cooldown: ${remainingCooldown}s remaining)` : ""
  logger.warn(
    `Account "${account.label}" marked unavailable due to Windsurf rate limit${cooldownInfo}: ${JSON.stringify(
      buildAccountDiagnosticSnapshot(account),
    )}`,
  )
}

export async function markAccountRateLimitRecovered(id: string): Promise<void> {
  await reportUpstreamSuccess(id)
  const account = getAccount(id)
  if (!account) return
  refreshAccountRuntimeAvailability(account)
  syncLegacyExhaustedState(account)

  const conn = getMutableProviderConnection(account.id)
  if (conn) syncAccountToConnection(conn, account)
  saveAccounts().catch((err: unknown) => {
    logger.error("Failed to auto-save accounts after recovery:", err)
  })
}

export function getMinimumCooldownSeconds(accounts: Array<Account>): number {
  let minCooldown = 0
  for (const account of accounts) {
    const availability = getAccountAvailability(account)
    if (availability.reason !== "cooldown") {
      continue
    }

    const cooldown = getRemainingCooldownSeconds(account.id)
    if (cooldown > 0 && (minCooldown === 0 || cooldown < minCooldown)) {
      minCooldown = cooldown
    }
  }
  return minCooldown
}
