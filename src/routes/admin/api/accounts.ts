import consola from "consola"
import { Hono } from "hono"

import type { Account } from "~/lib/accounts"

import { getAccountAvailability } from "~/lib/account-availability"
import { switchToNextAccount } from "~/lib/account-selection"
import {
  cancelTokenRefreshTimer,
  refreshQuotaForAccount,
  saveAccounts,
  serializeAccountForExport,
} from "~/lib/account-store"
import {
  getCodebuffAuthToken,
  getGitHubToken,
  getOAuthAccessToken,
  getOAuthApiKey,
  getWindsurfApiKey,
  getMimoServiceToken,
  getMimoPh,
  isOAuthAccount,
} from "~/lib/accounts"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { cacheModels, refreshModelsForAccount } from "~/lib/utils"
import {
  getOAuthAccountSubtitle,
  upgradeOAuthAccountLabels,
} from "~/services/oauth/account-label"
import {
  cancelOAuthRefreshTimer,
  scheduleOAuthRefreshForAccount,
} from "~/services/oauth/refresh-scheduler"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

import { createAccountRoutes } from "./account-create"
import { importAccountRoutes } from "./account-import"
import { updateProviderAccount } from "./account-update"
import { pollAccountFlow, deviceFlowRoutes } from "./device-flow"

export const accountApiRoutes = new Hono()
export const accountFlowApiRoutes = new Hono()

function getHasCredentials(account: Account): boolean {
  if (account.provider === "copilot") {
    return Boolean(getGitHubToken(account))
  }
  if (account.provider === "codebuff") {
    return Boolean(getCodebuffAuthToken(account))
  }
  if (account.provider === "windsurf") {
    return Boolean(getWindsurfApiKey(account))
  }
  if (isOAuthAccount(account)) {
    return Boolean(getOAuthAccessToken(account) || getOAuthApiKey(account))
  }
  return Boolean(getMimoServiceToken(account) && getMimoPh(account))
}

// Sanitize account for API response (omit sensitive tokens, compute isActive dynamically)
export function publicAccount(account: Account) {
  initializeProviderRegistry()
  const runtime = getProviderRuntime(account.provider)
  const availability = getAccountAvailability(account)
  const subtitle =
    isOAuthAccount(account) ? getOAuthAccountSubtitle(account) : undefined
  return {
    id: account.id,
    label: account.label,
    subtitle,
    provider: account.provider,
    availableModels: account.availableModels,
    enabled: account.enabled,
    priority: account.priority,
    isExhausted:
      availability.reason === "cooldown" || availability.reason === "quota",
    exhaustedAt: account.exhaustedAt,
    availabilityReason: availability.reason,
    retryAfterSeconds: availability.retryAfterSeconds || null,
    quotaState: account.quotaState ?? "unknown",
    quotaInfo: account.quotaInfo ?? null,
    supportsQuota: runtime.supports(account, "quota"),
    createdAt: account.createdAt,
    settings: account.settings ?? {},
    providerFeatures: runtime.descriptor.features,
    authStatus: account.runtimeState?.authStatus ?? "ready",
    authError: account.runtimeState?.lastError ?? null,
    hasCredentials: getHasCredentials(account),
    isActive: state.accounts.indexOf(account) === state.activeAccountIndex,
  }
}

// Mount sub-routers for extracted route modules
accountApiRoutes.route("/", createAccountRoutes)
accountApiRoutes.route("/", importAccountRoutes)
accountFlowApiRoutes.route("/", deviceFlowRoutes)

accountApiRoutes.get("/", async (c) => {
  if (upgradeOAuthAccountLabels(state.accounts)) {
    await saveAccounts()
  }
  return c.json({
    accounts: state.accounts.map((account) => publicAccount(account)),
  })
})

accountApiRoutes.post("/poll/:deviceCode", async (c) => {
  const result = await pollAccountFlow(c.req.param("deviceCode"))
  if (result.error) {
    return c.json({ error: result.error }, 404)
  }
  return c.json(result)
})

accountApiRoutes.put("/:id", async (c) => {
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  let body: {
    label?: string
    enabled?: boolean
    priority?: number
    authToken?: string
    apiKey?: string
    credentials?: Record<string, unknown>
    settings?: Record<string, unknown>
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  if (body.label) account.label = body.label
  if (typeof body.enabled === "boolean") {
    account.enabled = body.enabled
    if (!account.enabled) {
      cancelTokenRefreshTimer(account.id)
      cancelOAuthRefreshTimer(account.id)
    } else {
      scheduleOAuthRefreshForAccount(account)
    }
    consola.info(
      `Account "${account.label}" ${account.enabled ? "enabled" : "disabled"}`,
    )
  }
  if (typeof body.priority === "number") {
    account.priority = Math.max(0, Math.min(100, body.priority))
    consola.info(
      `Account "${account.label}" priority set to ${account.priority}`,
    )
  }

  await updateProviderAccount(account, body)

  await saveAccounts()
  cacheModels()
  return c.json({ account: publicAccount(account) })
})

accountApiRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const idx = state.accounts.findIndex((a) => a.id === id)
  if (idx === -1) return c.json({ error: "Account not found." }, 404)

  // Cancel any pending token refresh timer to prevent leaks
  cancelTokenRefreshTimer(id)
  cancelOAuthRefreshTimer(id)

  // Clear rate limit state for this account
  clearAccountRateLimitState(id)

  const wasActive = idx === state.activeAccountIndex
  state.accounts.splice(idx, 1)
  // Fix active index after deletion
  if (idx < state.activeAccountIndex) {
    // Deleted an account before the active one — shift index down
    state.activeAccountIndex = Math.max(0, state.activeAccountIndex - 1)
  } else if (wasActive) {
    // Deleted the active account itself — clamp then find next available
    state.activeAccountIndex = Math.min(
      idx,
      Math.max(0, state.accounts.length - 1),
    )
    switchToNextAccount()
  } else if (state.activeAccountIndex >= state.accounts.length) {
    state.activeAccountIndex = Math.max(0, state.accounts.length - 1)
  }
  await saveAccounts()
  return c.json({ ok: true })
})

accountApiRoutes.post("/:id/refresh", async (c) => {
  initializeProviderRegistry()
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  try {
    const runtime = getProviderRuntime(account.provider)
    if (runtime.refreshAuth) {
      await runtime.refreshAuth(account)
    }

    await refreshModelsForAccount(account)
    if (runtime.refreshQuota) {
      await runtime.refreshQuota(account)
    } else if (account.provider === "copilot") {
      await refreshQuotaForAccount(account)
    }
    await saveAccounts()
    cacheModels()
    return c.json({ account: publicAccount(account) })
  } catch (e: unknown) {
    consola.error("Failed to refresh account:", e)
    return c.json({ error: "Failed to refresh account." }, 502)
  }
})

// Set account priority (formerly "activate" - now sets highest priority)
accountApiRoutes.post("/:id/activate", async (c) => {
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  if (!account.enabled) {
    return c.json({ error: "Account is disabled." }, 409)
  }

  // Find minimum priority among all accounts
  const minPriority = Math.min(...state.accounts.map((a) => a.priority))
  // Set this account to highest priority (lower than current minimum)
  account.priority = Math.max(0, minPriority - 1)
  await saveAccounts()

  consola.info(
    `Account "${account.label}" set to highest priority (${account.priority})`,
  )

  return c.json({
    ok: true,
    account: publicAccount(account),
  })
})

// Export all accounts (includes credentials)
accountApiRoutes.get("/export", (c) => {
  const exported = state.accounts.map((account) =>
    serializeAccountForExport(account),
  )
  const filename = `copilot-api-accounts-${new Date().toISOString().slice(0, 10)}.json`
  c.header("Content-Disposition", `attachment; filename="${filename}"`)
  c.header("Content-Type", "application/json")
  return c.body(JSON.stringify({ accounts: exported }, null, 2))
})

// Export a single account (includes credentials)
accountApiRoutes.get("/:id/export", (c) => {
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  const exported = serializeAccountForExport(account)
  const safeName = account.label.replaceAll(/[^\w-]/g, "_")
  const filename = `copilot-api-account-${safeName}-${new Date().toISOString().slice(0, 10)}.json`
  c.header("Content-Disposition", `attachment; filename="${filename}"`)
  c.header("Content-Type", "application/json")
  return c.body(JSON.stringify({ accounts: [exported] }, null, 2))
})
