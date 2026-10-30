import { asNumber, asRecord } from "~/lib/json-shape"
import { summarizeCodexQuota } from "~/lib/quota/parsers"
import {
  DEFAULTS,
  type ProviderConnection,
} from "~/lib/provider-connections/types"

/** Reject incomplete/malformed evidence rather than interpreting it as unlimited. */
function remainingFromMeter(value: unknown): number | undefined {
  const meter = asRecord(value)
  if (!meter) return undefined
  const windows = [
    meter.primary_window ?? meter.primaryWindow,
    meter.secondary_window ?? meter.secondaryWindow,
  ].filter((window) => window !== undefined && window !== null)
  if (windows.length === 0) return undefined
  for (const value of windows) {
    const window = asRecord(value)
    const used = asNumber(window?.used_percent ?? window?.usedPercent)
    if (used === undefined || used < 0 || used > 100) return undefined
  }
  return summarizeCodexQuota({ rate_limit: meter }).remainingPercent
}

/**
 * Upgrade only the identifiable old snapshot-derived 24h lock. This is not a
 * fresh quota read: never call quota recovery (which lifts independent waits).
 */
export function repairPersistedCodexFeatureExhaustion(
  connection: ProviderConnection,
): void {
  const credential = connection.credentials[0]
  const meta = connection.metadata
  const snapshot = credential?.quota
  if (
    connection.protocol !== "codex-native"
    || !connection.enabled
    || !credential?.enabled
    || credential.status !== "quota_exhausted"
    || meta?.quotaState !== "exhausted"
    || meta.authStatus === "error"
    || snapshot?.provider !== "codex"
    || snapshot.unlimited !== false
    || snapshot.premiumInteractionsRemaining !== 0
    || snapshot.chatRemaining !== undefined
    || !Number.isFinite(snapshot.fetchedAt)
    || !Number.isFinite(credential.exhaustedAt)
    // A later snapshot may have overwritten genuine depletion out of order.
    || snapshot.fetchedAt > credential.exhaustedAt!
    || credential.cooldownUntil
      !== credential.exhaustedAt! + DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS
    || (meta.cooldownUntil !== undefined
      && meta.cooldownUntil !== credential.cooldownUntil)
    || (meta.quotaExhaustedAt !== undefined
      && meta.quotaExhaustedAt !== credential.exhaustedAt)
    || meta.isExhausted === true
    || meta.exhaustedAt !== undefined
  )
    return

  // Snapshot application records none of these. Even an older upstream error
  // makes provenance ambiguous; leave it for a successful live probe to recover.
  for (const source of [credential, meta]) {
    for (const key of [
      "lastError",
      "lastErrorAt",
      "lastRateLimitAt",
      "lastRateLimitReason",
    ]) {
      if (asRecord(source)?.[key] !== undefined) return
    }
  }

  const details = asRecord(snapshot.details)
  if (!details) return
  const shared = asRecord(details.rate_limit ?? details.rateLimit)
  if (
    !shared
    || shared.allowed === false
    || shared.limit_reached === true
    || shared.limitReached === true
  )
    return
  const remaining = remainingFromMeter(shared)
  if (remaining === undefined || remaining <= 0) return
  const additional =
    details.additional_rate_limits ?? details.additionalRateLimits
  const featureMeters = [
    details.code_review_rate_limit ?? details.codeReviewRateLimit,
  ]
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const feature = asRecord(item)
      featureMeters.push(feature?.rate_limit ?? feature?.rateLimit)
    }
  }
  if (!featureMeters.some((meter) => remainingFromMeter(meter) === 0)) return

  snapshot.premiumInteractionsRemaining = remaining
  credential.status = "ready"
  credential.exhaustedAt = undefined
  credential.cooldownUntil = undefined
  meta.quotaState = "available"
  meta.quotaExhaustedAt = undefined
  meta.cooldownUntil = undefined
}
