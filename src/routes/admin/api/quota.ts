import { Hono } from "hono"

import { getAccountAvailability } from "~/lib/account-availability"
import { refreshQuotaForAccount, saveAccounts } from "~/lib/account-store"
import { getAccount, isOAuthAccount, listAccounts } from "~/lib/accounts"
import { logger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  syncAccountToConnection,
} from "~/lib/provider-connections"
import { applyOAuthQuotaSnapshot } from "~/lib/quota"
import {
  canResetCodexQuota,
  resetCodexQuota,
  buildCodexQuotaMeta,
} from "~/lib/quota/codex"
import {
  enrichQuotaDetails,
  enrichQuotaInfoForResponse,
} from "~/lib/quota/cycles"
import { summarizeCodexQuota } from "~/lib/quota/parsers"
import {
  getOAuthAccountSubtitle,
  upgradeOAuthAccountLabels,
} from "~/services/oauth/account-label"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

export const quotaApiRoutes = new Hono()

/**
 * Derive the "active" account: the first enabled account by priority order.
 * Replaces the legacy state.activeAccountIndex concept.
 */
function getActiveAccountId(): string | undefined {
  const enabled = listAccounts()
    .filter((a) => a.enabled)
    .sort((a, b) => a.priority - b.priority)
  return enabled[0]?.id
}

quotaApiRoutes.get("/", async (c) => {
  initializeProviderRegistry()
  const accounts = listAccounts()
  if (upgradeOAuthAccountLabels(accounts)) {
    for (const account of accounts) {
      const conn = getMutableProviderConnection(account.id)
      if (conn) syncAccountToConnection(conn, account)
    }
    await saveAccounts()
  }
  const activeAccountId = getActiveAccountId()
  const response = accounts.map((account) => {
    const availability = getAccountAvailability(account)
    const subtitle =
      isOAuthAccount(account) ? getOAuthAccountSubtitle(account) : undefined
    return {
      availability,
      id: account.id,
      label: account.label,
      subtitle,
      provider: account.provider,
      enabled: account.enabled,
      priority: account.priority,
      isActive: account.id === activeAccountId,
      isExhausted:
        availability.reason === "cooldown" || availability.reason === "quota",
      quotaState: account.quotaState ?? "unknown",
      quotaInfo: enrichQuotaInfoForResponse(
        account.id,
        account.provider,
        account.quotaInfo ?? null,
      ),
      supportsQuota: getProviderRuntime(account.provider).supports(
        account,
        "quota",
      ),
    }
  })

  return c.json({ accounts: response })
})

// Force-refresh all account quotas from GitHub Copilot API
quotaApiRoutes.post("/refresh", async (c) => {
  initializeProviderRegistry()
  const results = []
  const errors = []

  for (const account of listAccounts()) {
    try {
      const runtime = getProviderRuntime(account.provider)
      if (runtime.refreshQuota) {
        await runtime.refreshQuota(account)
      } else if (account.provider === "copilot") {
        await refreshQuotaForAccount(account)
      }
      results.push({ id: account.id, label: account.label, success: true })
      logger.info(`Quota refreshed for account "${account.label}"`)
    } catch (err) {
      logger.warn(
        `Failed to refresh quota for account "${account.label}":`,
        err,
      )
      errors.push({ id: account.id, label: account.label, error: String(err) })
    }
  }

  if (errors.length > 0 && results.length === 0) {
    return c.json(
      { error: "Failed to refresh any quotas", details: errors },
      502,
    )
  }

  return c.json({
    success: true,
    refreshed: results.length,
    failed: errors.length,
    errors: errors.length > 0 ? errors : undefined,
  })
})

quotaApiRoutes.post("/:id/refresh", async (c) => {
  initializeProviderRegistry()
  const id = c.req.param("id")
  const account = getAccount(id)
  if (!account) {
    return c.json({ error: "Account not found." }, 404)
  }

  const runtime = getProviderRuntime(account.provider)
  if (!runtime.supports(account, "quota")) {
    return c.json({ error: "Quota is not supported for this provider." }, 400)
  }

  try {
    if (runtime.refreshQuota) {
      await runtime.refreshQuota(account)
    } else if (account.provider === "copilot") {
      await refreshQuotaForAccount(account)
    } else {
      return c.json({ error: "Quota refresh is not available." }, 400)
    }
    logger.info(`Quota refreshed for account "${account.label}"`)
    return c.json({
      success: true,
      id: account.id,
      quotaInfo: enrichQuotaInfoForResponse(
        account.id,
        account.provider,
        account.quotaInfo ?? null,
      ),
      quotaState: account.quotaState ?? "unknown",
    })
  } catch (err) {
    logger.warn(`Failed to refresh quota for account "${account.label}":`, err)
    return c.json(
      {
        error: "Failed to refresh quota.",
        details: String(err),
      },
      502,
    )
  }
})

quotaApiRoutes.post("/:id/reset", async (c) => {
  initializeProviderRegistry()
  const id = c.req.param("id")
  const account = getAccount(id)
  if (!account) {
    return c.json({ error: "Account not found." }, 404)
  }

  if (!isOAuthAccount(account) || account.provider !== "codex") {
    return c.json(
      { error: "Quota reset is only supported for Codex accounts." },
      400,
    )
  }

  const runtime = getProviderRuntime(account.provider)
  if (!runtime.supports(account, "quota")) {
    return c.json({ error: "Quota is not supported for this provider." }, 400)
  }

  const existingMeta = account.quotaInfo?.details?._codexMeta as
    | ReturnType<typeof buildCodexQuotaMeta>
    | undefined
  if (!canResetCodexQuota(existingMeta)) {
    return c.json(
      { error: "No manual reset credits available for this account." },
      400,
    )
  }

  try {
    const payload = await resetCodexQuota(account)
    const summary = summarizeCodexQuota(payload)
    const meta = buildCodexQuotaMeta(account, payload)
    const snapshot = {
      fetchedAt: Date.now(),
      provider: "codex" as const,
      unlimited: summary.unlimited,
      premiumInteractionsRemaining: summary.remainingPercent,
      details: enrichQuotaDetails("codex", {
        ...(payload as unknown as Record<string, unknown>),
        _codexMeta: meta,
      }),
    }
    applyOAuthQuotaSnapshot(account, snapshot)
    const conn = getMutableProviderConnection(account.id)
    if (conn) syncAccountToConnection(conn, account)
    await saveAccounts()
    logger.info(`Codex quota reset for account "${account.label}"`)
    return c.json({
      success: true,
      id: account.id,
      quotaInfo: enrichQuotaInfoForResponse(
        account.id,
        account.provider,
        account.quotaInfo ?? null,
      ),
      quotaState: account.quotaState ?? "unknown",
    })
  } catch (err) {
    logger.warn(
      `Failed to reset Codex quota for account "${account.label}":`,
      err,
    )
    return c.json(
      {
        error: "Failed to reset Codex quota.",
        details: String(err),
      },
      502,
    )
  }
})
