import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import { logger } from "~/lib/logger"
import {
  getConnectionProvider,
  getConnectionQuotaInfo,
  getConnectionQuotaState,
  getMutableProviderConnection,
  persistProviderConnections,
  setConnectionCooldownUntil,
  setConnectionRateLimitInfo,
} from "~/lib/provider-connections"
import { applyOAuthQuotaSnapshot } from "~/lib/quota"
import {
  buildCodexQuotaMeta,
  consumeCodexRateLimitResetCredit,
} from "~/lib/quota/codex"
import { fetchCodexQuota } from "~/lib/quota/fetchers/codex"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { getSystemSettings } from "~/lib/system-config"

type CodexQuotaMeta = ReturnType<typeof buildCodexQuotaMeta>
const RESET_LEAD_MS = 5 * 60_000
const resetting = new Set<string>()

interface AutoResetAttempt {
  creditKey: string
  redeemRequestId: string
  completed: boolean
}

function quotaMeta(snapshot?: QuotaSnapshot): CodexQuotaMeta | undefined {
  return snapshot?.details?._codexMeta as CodexQuotaMeta | undefined
}

function creditExpiry(expiresAt: string): number {
  const numeric = Number(expiresAt)
  if (Number.isFinite(numeric)) return numeric * (numeric < 1e12 ? 1000 : 1)
  return Date.parse(expiresAt)
}

export function expiringCodexResetCredit(
  meta: CodexQuotaMeta | undefined,
  now = Date.now(),
): CodexQuotaMeta["rateLimitResetCredits"][number] | undefined {
  if (!meta || meta.rateLimitResetCreditsError) return undefined
  if ((meta.rateLimitResetCreditsAvailableCount ?? 0) <= 0) return undefined
  return meta.rateLimitResetCredits
    .filter((credit) => {
      const expiry = creditExpiry(credit.expiresAt)
      return (
        credit.status === "available"
        && expiry > now
        && expiry - now <= RESET_LEAD_MS
      )
    })
    .sort((a, b) => creditExpiry(a.expiresAt) - creditExpiry(b.expiresAt))[0]
}

function automaticResetEnabled(connection: ProviderConnection): boolean {
  return (
    getSystemSettings().codexAutoReset
    && connection.enabled
    && connection.credentials[0]?.enabled === true
    && connection.credentials[0]?.status !== "disabled"
    && getConnectionProvider(connection) === "codex"
    && getMutableProviderConnection(connection.id) === connection
  )
}

function hasUsedQuota(meta: CodexQuotaMeta | undefined): boolean {
  return (
    meta?.windows.some(
      (window) =>
        ["five-hour", "weekly", "monthly"].includes(window.id)
        && window.usedPercent !== null
        && window.usedPercent > 0,
    ) ?? false
  )
}

/** Shared by manual resets and the background tick, so they cannot spend twice. */
export async function resetCodexQuotaForConnection(
  connection: ProviderConnection,
  options: { automatic?: boolean; signal?: AbortSignal } = {},
): Promise<QuotaSnapshot | undefined> {
  if (resetting.has(connection.id)) return undefined
  resetting.add(connection.id)
  const signal = options.signal ?? AbortSignal.timeout(20_000)
  try {
    let attempt: AutoResetAttempt | undefined
    if (options.automatic) {
      if (!automaticResetEnabled(connection)) return undefined
      // Cached quota can be five minutes old. Verify both usage and credits
      // immediately before spending, even if the normal refresh was throttled.
      const fresh = await fetchCodexQuota(connection, signal)
      applyOAuthQuotaSnapshot(connection, fresh)
      const meta = quotaMeta(fresh)
      const credit = expiringCodexResetCredit(meta)
      if (
        !credit
        || !hasUsedQuota(meta)
        || !automaticResetEnabled(connection)
      ) {
        return undefined
      }
      const creditKey = credit.id || credit.expiresAt
      const previous = connection.metadata?.codexAutoResetAttempt as
        | AutoResetAttempt
        | undefined
      if (previous?.creditKey === creditKey && previous.completed)
        return undefined
      attempt =
        previous?.creditKey === creditKey ?
          previous
        : {
            creditKey,
            redeemRequestId: crypto.randomUUID(),
            completed: false,
          }
      connection.metadata ??= {}
      connection.metadata.codexAutoResetAttempt = attempt
      // Preserve the redeem ID across timeouts and restarts. Retrying an
      // ambiguous POST must use the same upstream idempotency key.
      await persistProviderConnections()
      if (
        !automaticResetEnabled(connection)
        || !expiringCodexResetCredit(meta)
      ) {
        return undefined
      }
    }
    await consumeCodexRateLimitResetCredit(
      connection,
      signal,
      attempt?.redeemRequestId,
    )
    if (attempt) {
      attempt.completed = true
      await persistProviderConnections()
    }
    const snapshot = await fetchCodexQuota(connection, signal)
    applyOAuthQuotaSnapshot(connection, snapshot)
    if (getConnectionQuotaState(connection) !== "exhausted") {
      setConnectionCooldownUntil(connection, undefined)
      setConnectionRateLimitInfo(connection, undefined, undefined)
      clearAccountRateLimitState(connection.id)
    }
    return snapshot
  } finally {
    resetting.delete(connection.id)
  }
}

export async function autoResetExpiringCodexQuota(
  connection: ProviderConnection,
): Promise<void> {
  if (!automaticResetEnabled(connection)) return
  if (!expiringCodexResetCredit(quotaMeta(getConnectionQuotaInfo(connection))))
    return
  const snapshot = await resetCodexQuotaForConnection(connection, {
    automatic: true,
  })
  if (snapshot)
    logger.info(
      `Automatically reset expiring Codex quota for "${connection.name}"`,
    )
}
