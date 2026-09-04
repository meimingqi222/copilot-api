import { Hono } from "hono"

import type { Account } from "~/lib/legacy-accounts"

import {
  cancelTokenRefreshTimer,
  refreshQuotaForConnection,
  serializeConnectionForExport,
} from "~/lib/account-store"
import { getAccountAvailability } from "~/lib/legacy-accounts"
import {
  getCodebuffAuthToken,
  getGitHubToken,
  getOAuthAccessToken,
  getOAuthApiKey,
  getWindsurfApiKey,
  getMimoServiceToken,
  getMimoPh,
  isOAuthAccount,
} from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import {
  type ProviderConnection,
  getMutableProviderConnection,
  getProviderConnection,
  isAccountManagedConnection,
  listProviderConnections,
  persistProviderConnections,
  providerFromProtocol,
  removeProviderConnection,
} from "~/lib/provider-connections"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { readJsonBody } from "~/lib/request-body"
import { refreshModelsForConnection } from "~/lib/utils"
import {
  getOAuthAccountSubtitle,
  upgradeOAuthConnectionLabels,
} from "~/services/oauth/account-label"
import {
  cancelOAuthRefreshTimer,
  scheduleOAuthRefreshForConnection,
} from "~/services/oauth/refresh-scheduler"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

import { createAccountRoutes } from "./account-create"
import { importAccountRoutes } from "./account-import"
import {
  type UpdateAccountBody,
  applyConnectionPatchToConnection,
  parseBodyToPatch,
  patchRequiresModelRefresh,
} from "./account-update"
import { publicAccountFromConnection } from "./account-views"
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
 * Derive the "active" account: the first enabled account-managed connection by priority order.
 * Replaces the legacy state.activeAccountIndex concept.
 */
function getActiveAccountId(): string | undefined {
  const connections = listAccountManagedConnections()
  const enabled = connections
    .filter((c) => c.enabled)
    .sort((a, b) => a.priority - b.priority)
  return enabled[0]?.id
}

function listAccountManagedConnections(): Array<ProviderConnection> {
  return listProviderConnections().filter((c) => isAccountManagedConnection(c))
}

// Sanitize account for API response (omit sensitive tokens, compute isActive dynamically)
// Phase 4:仍通过 connectionToAccount 派生 Account 快照再调 publicAccount,
// 确保 JSON 形状逐字节不变。Phase 5 内联此派生。
export function publicAccount(account: Account) {
  initializeProviderRegistry()
  const runtime = getProviderRuntime(account.provider)
  const availability = getAccountAvailability(account)
  const subtitle =
    isOAuthAccount(account) ? getOAuthAccountSubtitle(account) : undefined
  // Phase 3:runtime.supports 翻转为收 ProviderConnection,
  // 通过 account.id 反查 connection 传入。
  const conn = getProviderConnection(account.id)
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
    supportsQuota: conn ? runtime.supports(conn, "quota") : false,
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
  const connections = listAccountManagedConnections()
  // OAuth label 升级:直接操作 connection,不再经由 Account 快照
  if (upgradeOAuthConnectionLabels(connections)) {
    await persistProviderConnections()
  }
  return c.json({
    accounts: connections.map((conn) => publicAccountFromConnection(conn)),
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
  const conn = getMutableProviderConnection(id)
  if (!conn || !isAccountManagedConnection(conn)) {
    return c.json({ error: "Account not found." }, 404)
  }

  let body: UpdateAccountBody
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const prevEnabled = conn.enabled
  const patch = parseBodyToPatch(conn, body)
  const copilotTokenRotated =
    conn.protocol === "copilot-native" && patch.credentialValue !== undefined
  applyConnectionPatchToConnection(conn, patch)

  // Copilot token 轮换:清除旧 copilotToken 并触发刷新
  if (copilotTokenRotated) {
    cancelTokenRefreshTimer(id)
    // 惰性刷新:下次请求时 ensureCopilotToken 会触发
  }

  if (typeof body.enabled === "boolean" && body.enabled !== prevEnabled) {
    if (!conn.enabled) {
      cancelTokenRefreshTimer(id)
    }
    scheduleOAuthRefreshForConnection(conn)
    logger.info(
      `Account "${conn.name}" ${conn.enabled ? "enabled" : "disabled"}`,
    )
  }

  await persistProviderConnections()

  if (patchRequiresModelRefresh(patch)) {
    try {
      await refreshModelsForConnection(conn)
    } catch (err) {
      logger.warn(`Failed to refresh models for "${conn.name}":`, err)
    }
  }

  return c.json({ account: publicAccountFromConnection(conn) })
})

accountApiRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const conn = getProviderConnection(id)
  if (!conn || !isAccountManagedConnection(conn)) {
    return c.json({ error: "Account not found." }, 404)
  }

  // Cancel any pending token refresh timer to prevent leaks
  cancelTokenRefreshTimer(id)
  cancelOAuthRefreshTimer(id)

  // Clear rate limit state for this account
  clearAccountRateLimitState(id)

  removeProviderConnection(id)
  await persistProviderConnections()
  return c.json({ ok: true })
})

accountApiRoutes.post("/:id/refresh", async (c) => {
  initializeProviderRegistry()
  const id = c.req.param("id")
  const conn = getMutableProviderConnection(id)
  if (!conn || !isAccountManagedConnection(conn)) {
    return c.json({ error: "Account not found." }, 404)
  }

  try {
    const provider = providerFromProtocol(conn.protocol) ?? "copilot"
    const runtime = getProviderRuntime(provider)
    if (runtime.refreshAuth) {
      await runtime.refreshAuth(conn)
    }

    await refreshModelsForConnection(conn)
    if (runtime.refreshQuota) {
      await runtime.refreshQuota(conn)
    } else if (provider === "copilot") {
      await refreshQuotaForConnection(conn)
    }
    await persistProviderConnections()
    return c.json({ account: publicAccountFromConnection(conn) })
  } catch (e: unknown) {
    logger.error("Failed to refresh account:", e)
    return c.json({ error: "Failed to refresh account." }, 502)
  }
})

// Set account priority (formerly "activate" - now sets highest priority)
accountApiRoutes.post("/:id/activate", async (c) => {
  const id = c.req.param("id")
  const conn = getMutableProviderConnection(id)
  if (!conn || !isAccountManagedConnection(conn)) {
    return c.json({ error: "Account not found." }, 404)
  }

  if (!conn.enabled) {
    return c.json({ error: "Account is disabled." }, 409)
  }

  // Find minimum priority among all account-managed connections
  const connections = listAccountManagedConnections()
  const minPriority = Math.min(...connections.map((c) => c.priority))
  // Set this connection to highest priority (lower than current minimum)
  conn.priority = Math.max(0, minPriority - 1)
  await persistProviderConnections()

  logger.info(
    `Account "${conn.name}" set to highest priority (${conn.priority})`,
  )

  return c.json({
    ok: true,
    account: publicAccountFromConnection(conn),
  })
})

// Export all accounts (includes credentials)
accountApiRoutes.get("/export", (c) => {
  const exported = listAccountManagedConnections().map((conn) =>
    serializeConnectionForExport(conn),
  )
  const filename = `copilot-api-accounts-${new Date().toISOString().slice(0, 10)}.json`
  c.header("Content-Disposition", `attachment; filename="${filename}"`)
  c.header("Content-Type", "application/json")
  return c.body(JSON.stringify({ accounts: exported }, null, 2))
})

// Export a single account (includes credentials)
accountApiRoutes.get("/:id/export", (c) => {
  const id = c.req.param("id")
  const conn = getProviderConnection(id)
  if (!conn || !isAccountManagedConnection(conn)) {
    return c.json({ error: "Account not found." }, 404)
  }

  const exported = serializeConnectionForExport(conn)
  const safeName = conn.name.replaceAll(/[^\w-]/g, "_")
  const filename = `copilot-api-account-${safeName}-${new Date().toISOString().slice(0, 10)}.json`
  c.header("Content-Disposition", `attachment; filename="${filename}"`)
  c.header("Content-Type", "application/json")
  return c.body(JSON.stringify({ accounts: [exported] }, null, 2))
})
