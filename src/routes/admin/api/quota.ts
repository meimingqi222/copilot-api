import consola from "consola"
import { Hono } from "hono"

import { refreshQuotaForAccount } from "~/lib/accounts"
import { state } from "~/lib/state"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

export const quotaApiRoutes = new Hono()

quotaApiRoutes.get("/", (c) => {
  initializeProviderRegistry()
  const accounts = state.accounts.map((account, idx) => ({
    id: account.id,
    label: account.label,
    provider: account.provider,
    enabled: account.enabled,
    priority: account.priority,
    isActive: idx === state.activeAccountIndex,
    isExhausted: account.isExhausted,
    quotaInfo: account.quotaInfo ?? null,
    supportsQuota: getProviderRuntime(account.provider).supports(
      account,
      "quota",
    ),
  }))

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
