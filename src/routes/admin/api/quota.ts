import { Hono } from "hono"
import consola from "consola"

import { refreshQuotaForAccount } from "~/lib/accounts"
import { state } from "~/lib/state"
import { toPublicUser } from "~/lib/users"

export const quotaApiRoutes = new Hono()

quotaApiRoutes.get("/", (c) => {
  const accounts = state.accounts.map(({ githubToken: _t, ...rest }) => ({
    id: rest.id,
    label: rest.label,
    isActive: state.accounts.indexOf(state.accounts.find((a) => a.id === rest.id)!) === state.activeAccountIndex,
    isExhausted: rest.isExhausted,
    quotaInfo: rest.quotaInfo ?? null,
  }))

  const users = state.users.map((u) => {
    const pub = toPublicUser(u)
    return {
      id: pub.id,
      username: pub.username,
      usedTokens: pub.usedTokens,
      quotaLimit: pub.quotaLimit,
      enabled: pub.enabled,
    }
  })

  return c.json({ accounts, users })
})

// Force-refresh all account quotas from GitHub Copilot API
quotaApiRoutes.post("/refresh", async (c) => {
  const results = []
  const errors = []

  for (const account of state.accounts) {
    try {
      await refreshQuotaForAccount(account)
      results.push({ id: account.id, label: account.label, success: true })
      consola.info(`Quota refreshed for account "${account.label}"`)
    } catch (err) {
      consola.warn(`Failed to refresh quota for account "${account.label}":`, err)
      errors.push({ id: account.id, label: account.label, error: String(err) })
    }
  }

  if (errors.length > 0 && results.length === 0) {
    return c.json({ error: "Failed to refresh any quotas", details: errors }, 502)
  }

  return c.json({
    success: true,
    refreshed: results.length,
    failed: errors.length,
    errors: errors.length > 0 ? errors : undefined,
  })
})

