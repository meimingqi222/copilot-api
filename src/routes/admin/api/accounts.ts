import { Hono } from "hono"

import { logger } from "~/lib/logger"
import {
  type ProviderConnection,
  accountManagedProvider,
  getMutableProviderConnection,
  getProviderConnection,
  isAccountManagedConnection,
  listProviderConnections,
  persistProviderConnections,
  removeProviderConnection,
  serializeConnectionForExport,
} from "~/lib/provider-connections"
import { refreshQuotaForConnection } from "~/lib/quota/scheduler"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { readJsonBody } from "~/lib/request-body"
import { refreshModelsForConnection } from "~/lib/utils"
import { cancelConnectionTokenRefresh } from "~/services/copilot/token-refresh"
import { upgradeOAuthConnectionLabels } from "~/services/oauth/account-label"
import {
  cancelOAuthRefreshTimer,
  scheduleOAuthRefreshForConnection,
} from "~/services/oauth/refresh-scheduler"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

import { createAccountRoutes } from "./account-create"
import { importAccountRoutes } from "./account-import"
import { accountModelRoutes } from "./account-models"
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

function listAccountManagedConnections(): Array<ProviderConnection> {
  return listProviderConnections().filter((c) => isAccountManagedConnection(c))
}

// Mount sub-routers for extracted route modules
accountApiRoutes.route("/", createAccountRoutes)
accountApiRoutes.route("/", importAccountRoutes)
accountApiRoutes.route("/", accountModelRoutes)
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
    cancelConnectionTokenRefresh(id)
    // 惰性刷新:下次请求时 ensureCopilotToken 会触发
  }

  if (typeof body.enabled === "boolean" && body.enabled !== prevEnabled) {
    if (!conn.enabled) {
      cancelConnectionTokenRefresh(id)
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
  cancelConnectionTokenRefresh(id)
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
    const provider = accountManagedProvider(conn)
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
