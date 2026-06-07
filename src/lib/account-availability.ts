import consola from "consola"

import type { Account, AccountQuotaState } from "~/lib/accounts"

import { buildAccountDiagnosticSnapshot } from "~/lib/account-diagnostics"
import { saveAccounts } from "~/lib/account-store"
import {
  findCredential,
  isCredentialAvailable,
  markCredentialCooldown,
  refreshCredentialAvailability,
  resetCredentialStatus,
  type RateLimitInfo,
} from "~/lib/provider-connections"
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

  const credential = findCredentialForAccount(account)
  if (credential && !isCredentialAvailable(credential)) {
    if (credential.status === "cooldown" && credential.cooldownUntil) {
      const remaining = Math.ceil(
        (credential.cooldownUntil - Date.now()) / 1000,
      )
      return {
        available: false,
        reason: "cooldown",
        retryAfterSeconds: Math.max(remaining, 0),
      }
    }
    if (credential.status === "auth_error") {
      return { available: false, reason: "error", retryAfterSeconds: 10 }
    }
    if (credential.status === "quota_exhausted") {
      return { available: false, reason: "quota", retryAfterSeconds: 0 }
    }
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

  const status = response.status
  const remainingCooldown = getRemainingCooldownSeconds(id)
  account.lastRateLimitAt = Date.now()
  account.cooldownUntil =
    remainingCooldown > 0 ? Date.now() + remainingCooldown * 1000 : undefined
  account.lastRateLimitReason =
    status === 429 ? "upstream_429" : `upstream_${status}`
  syncLegacyExhaustedState(account)

  const credential = findCredentialForAccount(account)
  if (credential) {
    const retryAfterMs =
      remainingCooldown > 0 ? remainingCooldown * 1000 : undefined
    const info: RateLimitInfo = {
      retryAfterMs,
      reason: status === 429 ? "upstream_429" : `upstream_${status}`,
    }
    refreshCredentialAvailability(credential)
    if (credential.status === "ready") {
      markCredentialCooldown(credential, info)
    }
  }

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

  const credential = findCredentialForAccount(account)
  if (credential && credential.status !== "ready" && credential.enabled) {
    resetCredentialStatus(credential)
  }

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

function findCredentialForAccount(
  account: Account,
): import("~/lib/provider-connections/types").ApiCredential | undefined {
  const found = findCredential(account.id, account.id)
  return found?.credential
}
