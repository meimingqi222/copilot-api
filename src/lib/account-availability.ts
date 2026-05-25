import consola from "consola"

import type { Account, AccountQuotaState } from "~/lib/accounts"

import { buildAccountDiagnosticSnapshot } from "~/lib/account-diagnostics"
import { saveAccounts } from "~/lib/account-store"
import {
  getRemainingCooldownSeconds,
  reportUpstreamRateLimit,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"
import { state } from "~/lib/state"

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

  // Check if the account's cooldownUntil field is set but the rate-limit state
  // indicates no active cooldown, which means the account's cooldown has expired
  // and we need to clear the stale cooldownUntil timestamp.
  if (account.cooldownUntil && account.cooldownUntil < Date.now()) {
    account.cooldownUntil = undefined
    account.lastRateLimitReason = undefined
    syncLegacyExhaustedState(account)
    consola.info(
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
  const account = state.accounts.find((candidate) => candidate.id === id)
  if (!account) return

  const remainingCooldown = getRemainingCooldownSeconds(id)
  account.lastRateLimitAt = Date.now()
  account.cooldownUntil =
    remainingCooldown > 0 ? Date.now() + remainingCooldown * 1000 : undefined
  account.lastRateLimitReason = "upstream_429"
  syncLegacyExhaustedState(account)
  saveAccounts().catch((err: unknown) => {
    consola.error("Failed to auto-save accounts after rate limit:", err)
  })

  const cooldownInfo =
    remainingCooldown > 0 ? ` (cooldown: ${remainingCooldown}s remaining)` : ""
  consola.warn(
    `Account "${account.label}" marked unavailable due to upstream rate limit${cooldownInfo}: ${JSON.stringify(
      buildAccountDiagnosticSnapshot(account),
    )}`,
  )
}

export async function markAccountRateLimitRecovered(id: string): Promise<void> {
  await reportUpstreamSuccess(id)
  const account = state.accounts.find((candidate) => candidate.id === id)
  if (!account) return
  refreshAccountRuntimeAvailability(account)
  syncLegacyExhaustedState(account)
  saveAccounts().catch((err: unknown) => {
    consola.error("Failed to auto-save accounts after recovery:", err)
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
