import consola from "consola"
import { Hono } from "hono"

import { getAccountAvailability } from "~/lib/account-availability"
import { refreshQuotaForAccount, saveAccounts } from "~/lib/account-store"
import { isOAuthAccount } from "~/lib/accounts"
import { state } from "~/lib/state"
import {
  getOAuthAccountSubtitle,
  upgradeOAuthAccountLabels,
} from "~/services/oauth/account-label"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

export const quotaApiRoutes = new Hono()

quotaApiRoutes.get("/", async (c) => {
  initializeProviderRegistry()
  if (upgradeOAuthAccountLabels(state.accounts)) {
    await saveAccounts()
  }
  const accounts = state.accounts.map((account, idx) => {
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
      isActive: idx === state.activeAccountIndex,
      isExhausted:
        availability.reason === "cooldown" || availability.reason === "quota",
      quotaState: account.quotaState ?? "unknown",
      quotaInfo: account.quotaInfo ?? null,
      supportsQuota: getProviderRuntime(account.provider).supports(
        account,
        "quota",
      ),
    }
  })

  return c.json({ accounts })
})

// Force-refresh all account quotas from GitHub Copilot API
quotaApiRoutes.post("/refresh", async (c) => {
  initializeProviderRegistry()
  const results = []
  const errors = []

  for (const account of state.accounts) {
    try {
      const runtime = getProviderRuntime(account.provider)
      if (runtime.refreshQuota) {
        await runtime.refreshQuota(account)
      } else if (account.provider === "copilot") {
        await refreshQuotaForAccount(account)
      }
      results.push({ id: account.id, label: account.label, success: true })
      consola.info(`Quota refreshed for account "${account.label}"`)
    } catch (err) {
      consola.warn(
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
  const account = state.accounts.find((item) => item.id === id)
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
    consola.info(`Quota refreshed for account "${account.label}"`)
    return c.json({
      success: true,
      id: account.id,
      quotaInfo: account.quotaInfo ?? null,
      quotaState: account.quotaState ?? "unknown",
    })
  } catch (err) {
    consola.warn(`Failed to refresh quota for account "${account.label}":`, err)
    return c.json(
      {
        error: "Failed to refresh quota.",
        details: String(err),
      },
      502,
    )
  }
})
