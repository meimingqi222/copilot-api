import { Hono } from "hono"

import { refreshQuotaForConnection, saveAccounts } from "~/lib/account-store"
import { logger } from "~/lib/logger"
import {
  getConnectionQuotaInfo,
  getConnectionQuotaState,
  getMutableProviderConnection,
  getProviderConnection,
  isAccountManagedConnection,
  isOAuthConnection,
  listAccountManagedConnections,
  providerFromProtocol,
  setConnectionCooldownUntil,
  setConnectionRateLimitInfo,
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
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { upgradeOAuthConnectionLabels } from "~/services/oauth/account-label"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

import {
  connectionSubtitle,
  getConnectionAvailabilityForAdmin,
} from "./account-views"

export const quotaApiRoutes = new Hono()

/**
 * Derive the "active" account: the first enabled account by priority order.
 * Replaces the legacy state.activeAccountIndex concept.
 */
function getActiveAccountId(): string | undefined {
  // 使用 connection 原生列表(替代 listAccounts())
  const enabled = listAccountManagedConnections()
    .filter((c) => c.enabled)
    .sort((a, b) => a.priority - b.priority)
  return enabled[0]?.id
}

quotaApiRoutes.get("/", async (c) => {
  initializeProviderRegistry()
  // 使用 connection 原生列表(替代 listAccounts())
  const connections = listAccountManagedConnections()
  // OAuth label 升级:直接操作 connection,不再经由 Account 快照
  if (upgradeOAuthConnectionLabels(connections)) {
    await saveAccounts()
  }
  const activeAccountId = getActiveAccountId()
  const response = connections.map((conn) => {
    const availability = getConnectionAvailabilityForAdmin(conn)
    // 使用 connectionSubtitle(isOAuthConnection + getOAuthAccountSubtitle 的 compat 封装)
    const subtitle = connectionSubtitle(conn)
    const provider = providerFromProtocol(conn.protocol) ?? "copilot"
    return {
      availability,
      id: conn.id,
      label: conn.name,
      subtitle,
      provider,
      enabled: conn.enabled,
      priority: conn.priority,
      isActive: conn.id === activeAccountId,
      isExhausted:
        availability.reason === "cooldown" || availability.reason === "quota",
      // 使用 connection 原生配额读取器
      quotaState: getConnectionQuotaState(conn) ?? "unknown",
      quotaInfo: enrichQuotaInfoForResponse(
        conn.id,
        provider,
        getConnectionQuotaInfo(conn) ?? null,
      ),
      supportsQuota: getProviderRuntime(provider).supports(conn, "quota"),
    }
  })

  return c.json({ accounts: response })
})

// Force-refresh all account quotas from GitHub Copilot API
quotaApiRoutes.post("/refresh", async (c) => {
  initializeProviderRegistry()
  const results = []
  const errors = []

  // 使用 connection 原生列表(替代 listAccounts())
  for (const conn of listAccountManagedConnections()) {
    const provider = providerFromProtocol(conn.protocol) ?? "copilot"
    try {
      const runtime = getProviderRuntime(provider)
      const mutableConn = getMutableProviderConnection(conn.id)
      if (runtime.refreshQuota && mutableConn) {
        await runtime.refreshQuota(mutableConn)
      } else if (provider === "copilot") {
        await refreshQuotaForConnection(mutableConn ?? conn)
      }
      results.push({ id: conn.id, label: conn.name, success: true })
      logger.info(`Quota refreshed for account "${conn.name}"`)
    } catch (err) {
      logger.warn(`Failed to refresh quota for account "${conn.name}":`, err)
      errors.push({ id: conn.id, label: conn.name, error: String(err) })
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
  // 使用 connection 原生访问器(替代 getAccount())
  const conn = getProviderConnection(id)
  if (!conn || !isAccountManagedConnection(conn)) {
    return c.json({ error: "Account not found." }, 404)
  }

  const provider = providerFromProtocol(conn.protocol) ?? "copilot"
  const runtime = getProviderRuntime(provider)
  const mutableConn = getMutableProviderConnection(id)
  if (!mutableConn || !runtime.supports(mutableConn, "quota")) {
    return c.json({ error: "Quota is not supported for this provider." }, 400)
  }

  try {
    if (runtime.refreshQuota) {
      await runtime.refreshQuota(mutableConn)
    } else if (provider === "copilot") {
      await refreshQuotaForConnection(mutableConn)
    } else {
      return c.json({ error: "Quota refresh is not available." }, 400)
    }
    logger.info(`Quota refreshed for account "${conn.name}"`)
    return c.json({
      success: true,
      id: conn.id,
      // 使用 connection 原生配额读取器
      quotaInfo: enrichQuotaInfoForResponse(
        conn.id,
        provider,
        getConnectionQuotaInfo(conn) ?? null,
      ),
      quotaState: getConnectionQuotaState(conn) ?? "unknown",
    })
  } catch (err) {
    logger.warn(`Failed to refresh quota for account "${conn.name}":`, err)
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
  // 使用 connection 原生访问器(替代 getAccount())
  const conn = getProviderConnection(id)
  if (!conn || !isAccountManagedConnection(conn)) {
    return c.json({ error: "Account not found." }, 404)
  }

  const provider = providerFromProtocol(conn.protocol) ?? "copilot"
  // 使用 isOAuthConnection 替代 isOAuthAccount;codex 是 OAuth provider
  if (!isOAuthConnection(conn) || provider !== "codex") {
    return c.json(
      { error: "Quota reset is only supported for Codex accounts." },
      400,
    )
  }

  const runtime = getProviderRuntime(provider)
  const resetConn = getProviderConnection(id)
  if (!resetConn || !runtime.supports(resetConn, "quota")) {
    return c.json({ error: "Quota is not supported for this provider." }, 400)
  }

  // quotaInfo.details._codexMeta 仍需从 connection 读取
  const quotaInfo = getConnectionQuotaInfo(conn)
  const existingMeta = quotaInfo?.details?._codexMeta as
    | ReturnType<typeof buildCodexQuotaMeta>
    | undefined
  if (!canResetCodexQuota(existingMeta)) {
    return c.json(
      { error: "No manual reset credits available for this account." },
      400,
    )
  }

  try {
    const connection = getMutableProviderConnection(conn.id)
    if (!connection) {
      return c.json({ error: "Connection not found." }, 404)
    }
    const payload = await resetCodexQuota(connection)
    const summary = summarizeCodexQuota(payload)
    const meta = buildCodexQuotaMeta(connection, payload)
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
    applyOAuthQuotaSnapshot(connection, snapshot)
    // Clear any residual cooldown state left over from the prior
    // quota-exhausted period. `applyOAuthQuotaSnapshot` flips quotaState to
    // "available" but does not touch cooldownUntil (persisted) or the
    // in-memory rate-limiter state — without clearing both, the account
    // stays flagged as unavailable ("cooldown") even though the upstream
    // quota has recovered to 100%.
    // 直接通过 connection 原生 setter 清理,不再经由 Account 快照
    const syncConn = getMutableProviderConnection(conn.id)
    if (syncConn) {
      setConnectionCooldownUntil(syncConn, undefined)
      setConnectionRateLimitInfo(syncConn, undefined, undefined)
    }
    clearAccountRateLimitState(conn.id)
    await saveAccounts()
    logger.info(`Codex quota reset for account "${conn.name}"`)
    return c.json({
      success: true,
      id: conn.id,
      // 使用 connection 原生配额读取器
      quotaInfo: enrichQuotaInfoForResponse(
        conn.id,
        provider,
        getConnectionQuotaInfo(conn) ?? null,
      ),
      quotaState: getConnectionQuotaState(conn) ?? "unknown",
    })
  } catch (err) {
    logger.warn(`Failed to reset Codex quota for account "${conn.name}":`, err)
    return c.json(
      {
        error: "Failed to reset Codex quota.",
        details: String(err),
      },
      502,
    )
  }
})
