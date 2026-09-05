import { logger } from "~/lib/logger"
import { DEFAULTS } from "~/lib/provider-connections"
import { getRemainingCooldownSeconds } from "~/lib/rate-limit"

import type { Account } from "./accounts"

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
    // Also reset quotaState if we were in exhausted state.
    // This prevents permanent lock-out for OAuth providers.
    if (account.quotaState === "exhausted") {
      account.quotaState = "unknown"
      account.quotaExhaustedAt = undefined
    }
    syncLegacyExhaustedState(account)
    logger.info(
      `Account cooldown expired — re-activating: ${JSON.stringify({
        id: account.id,
        provider: account.provider,
      })}`,
    )
    return true
  }

  // Auto-recover quota_exhausted state after QUOTA_EXHAUSTED_AUTO_RECOVERY_MS.
  // Handles the case where cooldownUntil was not set (e.g. upstream returned
  // 429 with a quota body but no parseable reset time / Retry-After header).
  if (
    account.quotaState === "exhausted"
    && account.quotaExhaustedAt
    && Date.now() - account.quotaExhaustedAt
      >= DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS
  ) {
    account.quotaState = "unknown"
    account.quotaExhaustedAt = undefined
    syncLegacyExhaustedState(account)
    logger.info(
      `Account quota exhausted timed out — re-activating: ${JSON.stringify({
        id: account.id,
        provider: account.provider,
      })}`,
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
    // 配额耗尽时,根据 quotaExhaustedAt + 自动恢复窗口计算剩余时间,
    // 客户端据此退避,避免立即重试导致雪崩。
    let retryAfterSeconds = 0
    if (account.quotaExhaustedAt) {
      const recoverAt =
        account.quotaExhaustedAt + DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS
      const remainingMs = recoverAt - Date.now()
      if (remainingMs > 0) {
        retryAfterSeconds = Math.ceil(remainingMs / 1000)
      }
    }
    // 如果有 cooldownUntil(更精确的恢复时间,如 Codex usage_limit_reached
    // 返回了 resets_at),优先使用 cooldownUntil。
    if (account.cooldownUntil && account.cooldownUntil > Date.now()) {
      const cooldownSec = Math.ceil((account.cooldownUntil - Date.now()) / 1000)
      if (cooldownSec > retryAfterSeconds) {
        retryAfterSeconds = cooldownSec
      }
    }
    return { available: false, reason: "quota", retryAfterSeconds }
  }

  return { available: true, reason: "available", retryAfterSeconds: 0 }
}
