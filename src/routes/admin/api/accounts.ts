import { Hono } from "hono"

import type { Account } from "~/lib/accounts"

import { getAccountAvailability } from "~/lib/account-availability"
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
  getAccount,
  isOAuthAccount,
  listAccounts,
} from "~/lib/accounts"
import { logger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  removeProviderConnection,
  syncAccountToConnection,
} from "~/lib/provider-connections"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { readJsonBody } from "~/lib/request-body"
import { refreshModelsForAccount } from "~/lib/utils"
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
import { type UpdateAccountBody, updateProviderAccount } from "./account-update"
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

/**
 * Derive the "active" account: the first enabled account by priority order.
 * Replaces the legacy state.activeAccountIndex concept.
 */
function getActiveAccountId(): string | undefined {
  const accounts = listAccounts()
  const enabled = accounts
    .filter((a) => a.enabled)
    .sort((a, b) => a.priority - b.priority)
  return enabled[0]?.id
}

/**
 * Sync an Account's mutations back to its underlying connection, then persist.
 * Receives the already-mutated Account snapshot so changes are not lost
 * (getAccount(id) would return a fresh un-mutated snapshot from the connection).
 */
async function syncAndSave(account: Account): Promise<void> {
  const conn = getMutableProviderConnection(account.id)
  if (conn) {
    syncAccountToConnection(conn, account)
  }
  await saveAccounts()
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
    isActive: account.id === getActiveAccountId(),
  }
}

// Mount sub-routers for extracted route modules
accountApiRoutes.route("/", createAccountRoutes)
accountApiRoutes.route("/", importAccountRoutes)
accountFlowApiRoutes.route("/", deviceFlowRoutes)

accountApiRoutes.get("/", async (c) => {
  const accounts = listAccounts()
  if (upgradeOAuthAccountLabels(accounts)) {
    // Sync label changes back to connections
    for (const account of accounts) {
      const conn = getMutableProviderConnection(account.id)
      if (conn) syncAccountToConnection(conn, account)
    }
    await saveAccounts()
  }
  return c.json({
    accounts: accounts.map((account) => publicAccount(account)),
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
  const account = getAccount(id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  let body: UpdateAccountBody
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const prevEnabled = account.enabled
  await updateProviderAccount(account, body)
  if (typeof body.enabled === "boolean" && body.enabled !== prevEnabled) {
    if (!account.enabled) {
      // Disabling only removes the account from request routing. Keep the
      // OAuth token refresh running so its access token stays valid and
      // on-demand actions (e.g. quota refresh) don't fail with 401.
      cancelTokenRefreshTimer(account.id)
    }
    // (Re)schedule OAuth refresh regardless of enabled state. For non-OAuth
    // accounts this is a no-op (cancels the timer internally).
    scheduleOAuthRefreshForAccount(account)
    logger.info(
      `Account "${account.label}" ${account.enabled ? "enabled" : "disabled"}`,
    )
  }

  await syncAndSave(account)
  return c.json({ account: publicAccount(account) })
})

accountApiRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const account = getAccount(id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  // Cancel any pending token refresh timer to prevent leaks
  cancelTokenRefreshTimer(id)
  cancelOAuthRefreshTimer(id)

  // Clear rate limit state for this account
  clearAccountRateLimitState(id)

  removeProviderConnection(id)
  await saveAccounts({
    allowEmpty: listAccounts().length === 0,
    allowShrink: true,
  })
  return c.json({ ok: true })
})

accountApiRoutes.post("/:id/refresh", async (c) => {
  initializeProviderRegistry()
  const id = c.req.param("id")
  const account = getAccount(id)
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
    await syncAndSave(account)
    return c.json({ account: publicAccount(account) })
  } catch (e: unknown) {
    logger.error("Failed to refresh account:", e)
    return c.json({ error: "Failed to refresh account." }, 502)
  }
})

// Set account priority (formerly "activate" - now sets highest priority)
accountApiRoutes.post("/:id/activate", async (c) => {
  const id = c.req.param("id")
  const account = getAccount(id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  if (!account.enabled) {
    return c.json({ error: "Account is disabled." }, 409)
  }

  // Find minimum priority among all accounts
  const accounts = listAccounts()
  const minPriority = Math.min(...accounts.map((a) => a.priority))
  // Set this account to highest priority (lower than current minimum)
  account.priority = Math.max(0, minPriority - 1)
  await syncAndSave(account)

  logger.info(
    `Account "${account.label}" set to highest priority (${account.priority})`,
  )

  return c.json({
    ok: true,
    account: publicAccount(account),
  })
})

// Export all accounts (includes credentials)
accountApiRoutes.get("/export", (c) => {
  const exported = listAccounts().map((account) =>
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
  const account = getAccount(id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  const exported = serializeAccountForExport(account)
  const safeName = account.label.replaceAll(/[^\w-]/g, "_")
  const filename = `copilot-api-account-${safeName}-${new Date().toISOString().slice(0, 10)}.json`
  c.header("Content-Disposition", `attachment; filename="${filename}"`)
  c.header("Content-Type", "application/json")
  return c.body(JSON.stringify({ accounts: [exported] }, null, 2))
})
