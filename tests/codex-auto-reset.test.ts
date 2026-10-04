import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import { getMutableProviderConnection } from "~/lib/provider-connections"
import * as connectionStore from "~/lib/provider-connections/store"
import { applyOAuthQuotaSnapshot } from "~/lib/quota"
import { buildCodexQuotaMeta } from "~/lib/quota/codex"
import {
  autoResetExpiringCodexQuota,
  expiringCodexResetCredit,
  resetCodexQuotaForConnection,
} from "~/lib/quota/codex-reset"
import * as upstream from "~/lib/quota/upstream-proxy"
import { refreshAllQuotas } from "~/lib/quota/scheduler"
import { initializeSystemConfig, updateSystemConfig } from "~/lib/system-config"
import { initializeProviderRegistry } from "~/services/providers"

import { listTestAccounts, setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listTestAccounts()
const normal = {
  logLevel: "info",
  requestDump: false,
  memoryVerbose: false,
  performanceDetails: true,
  debugMinutes: 15,
} as const
let store: ReturnType<
  typeof spyOn<typeof connectionStore, "saveProviderConnections">
>
let proxy: ReturnType<typeof spyOn<typeof upstream, "executeUpstreamProxyCall">>
let used: number
let weeklyUsed: number
let credits: Array<{ id: string; status: string; expires_at: string }>
let redeemIds: string[]
let failPost: boolean
let failAfterPost: boolean
let keepStale: boolean

function usage() {
  return {
    plan_type: "team",
    rate_limit: {
      primary_window: { used_percent: used, limit_window_seconds: 18000 },
      secondary_window: {
        used_percent: weeklyUsed,
        limit_window_seconds: 604800,
      },
    },
    rate_limit_reset_credits: { available_count: credits.length },
  }
}

function connection() {
  const conn = getMutableProviderConnection("auto-reset")
  if (!conn) throw new Error("missing test connection")
  return conn
}

function cacheQuota(): void {
  const conn = connection()
  const meta = buildCodexQuotaMeta(conn, usage(), {
    availableCount: credits.length,
    error: null,
    credits: credits.map((credit) => ({
      id: credit.id,
      status: credit.status,
      grantedAt: "",
      expiresAt: credit.expires_at,
    })),
  })
  applyOAuthQuotaSnapshot(conn, {
    fetchedAt: Date.now(),
    provider: "codex",
    unlimited: false,
    premiumInteractionsRemaining: 100 - Math.max(used, weeklyUsed),
    details: { ...usage(), _codexMeta: meta },
  })
}

beforeEach(() => {
  store = spyOn(connectionStore, "saveProviderConnections").mockResolvedValue(
    undefined,
  )
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  updateSystemConfig({ ...normal, codexAutoReset: true })
  initializeProviderRegistry()
  setTestAccounts([
    {
      id: "auto-reset",
      label: "Codex auto",
      provider: "codex",
      enabled: true,
      priority: 0,
      quotaState: "available",
      createdAt: Date.now(),
      credentials: { accessToken: "test-token" },
    },
  ])
  used = 66
  weeklyUsed = 70
  credits = [
    {
      id: "expiring",
      status: "available",
      expires_at: new Date(Date.now() + 240_000).toISOString(),
    },
  ]
  redeemIds = []
  failPost = false
  failAfterPost = false
  keepStale = false
  proxy = spyOn(upstream, "executeUpstreamProxyCall").mockImplementation(
    async (_conn, request) => {
      if (request.method === "POST") {
        const body = JSON.parse(request.body!) as { redeem_request_id: string }
        redeemIds.push(body.redeem_request_id)
        if (failPost) throw new Error("ambiguous timeout")
        if (!keepStale) {
          used = 0
          weeklyUsed = 0
          credits.shift()
        }
        return { statusCode: 200, headers: {}, body: "{}" }
      }
      if (failAfterPost && redeemIds.length) throw new Error("refresh failed")
      const body =
        request.url.includes("rate-limit-reset-credits") ?
          { available_count: credits.length, credits }
        : usage()
      return { statusCode: 200, headers: {}, body: JSON.stringify(body) }
    },
  )
  cacheQuota()
})

afterEach(() => {
  proxy.mockRestore()
  store.mockRestore()
  setTestAccounts(originalAccounts)
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
})

test("five-minute boundary, expired credits, timestamps and earliest expiry", () => {
  const now = Date.parse("2026-10-04T22:41:00Z")
  const meta = buildCodexQuotaMeta(connection(), usage(), {
    availableCount: 3,
    error: null,
    credits: [
      {
        id: "later",
        status: "available",
        grantedAt: "",
        expiresAt: new Date(now + 300_000).toISOString(),
      },
      {
        id: "first",
        status: "available",
        grantedAt: "",
        expiresAt: String((now + 60_000) / 1000),
      },
      {
        id: "expired",
        status: "available",
        grantedAt: "",
        expiresAt: new Date(now).toISOString(),
      },
    ],
  })
  expect(expiringCodexResetCredit(meta, now)?.id).toBe("first")
  meta.rateLimitResetCredits.splice(1, 2)
  expect(expiringCodexResetCredit(meta, now)?.id).toBe("later")
  expect(expiringCodexResetCredit(meta, now - 1)).toBeUndefined()
  expect(expiringCodexResetCredit(meta, now + 300_000)).toBeUndefined()
  meta.rateLimitResetCredits[0]!.expiresAt = "invalid"
  expect(expiringCodexResetCredit(meta, now)).toBeUndefined()
})

test("background scheduler consumes one expiring credit and refreshes quota", async () => {
  credits.push({
    id: "later",
    status: "available",
    expires_at: new Date(Date.now() + 10 * 86400_000).toISOString(),
  })
  cacheQuota()
  connection().credentials[0]!.status = "quota_exhausted"
  connection().credentials[0]!.cooldownUntil = Date.now() + 86400_000
  await refreshAllQuotas()
  expect(redeemIds).toHaveLength(1)
  expect(credits.map((credit) => credit.id)).toEqual(["later"])
  expect(connection().credentials[0]!.quota?.premiumInteractionsRemaining).toBe(
    100,
  )
  expect(connection().credentials[0]!.status).toBe("ready")
  expect(connection().credentials[0]!.cooldownUntil).toBeUndefined()
  await refreshAllQuotas()
  expect(redeemIds).toHaveLength(1)
})

test("full fresh quota skips reset even when cached quota was partly used", async () => {
  used = 0
  weeklyUsed = 0
  await autoResetExpiringCodexQuota(connection())
  expect(redeemIds).toHaveLength(0)
  used = 1
  await autoResetExpiringCodexQuota(connection())
  expect(redeemIds).toHaveLength(1)
})

test("weekly usage alone is enough to make a reset useful", async () => {
  used = 0
  await autoResetExpiringCodexQuota(connection())
  expect(redeemIds).toHaveLength(1)
})

test("disabled switch and disabled accounts or credentials do not probe or spend", async () => {
  updateSystemConfig({ ...normal, codexAutoReset: false })
  await autoResetExpiringCodexQuota(connection())
  updateSystemConfig({ ...normal, codexAutoReset: true })
  connection().enabled = false
  await autoResetExpiringCodexQuota(connection())
  connection().enabled = true
  connection().credentials[0]!.enabled = false
  await autoResetExpiringCodexQuota(connection())
  expect(proxy).not.toHaveBeenCalled()
})

test("fresh expired or missing credits never consume a later credit", async () => {
  credits = []
  await autoResetExpiringCodexQuota(connection())
  expect(redeemIds).toHaveLength(0)
  credits = [
    {
      id: "expired",
      status: "available",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    },
  ]
  cacheQuota()
  await autoResetExpiringCodexQuota(connection())
  expect(redeemIds).toHaveLength(0)
})

test("failed credit details prevent automatic spending", async () => {
  const implementation = proxy.getMockImplementation()!
  proxy.mockImplementation(async (conn, request) => {
    if (request.url.includes("rate-limit-reset-credits")) {
      return { statusCode: 403, headers: {}, body: "{}" }
    }
    return implementation(conn, request)
  })
  await autoResetExpiringCodexQuota(connection())
  expect(redeemIds).toHaveLength(0)
})

test("manual and automatic resets cannot overlap", async () => {
  const automatic = autoResetExpiringCodexQuota(connection())
  expect(await resetCodexQuotaForConnection(connection())).toBeUndefined()
  await automatic
  expect(redeemIds).toHaveLength(1)
})

test("ambiguous retry reuses the persisted redeem ID, including after reload", async () => {
  failPost = true
  await expect(autoResetExpiringCodexQuota(connection())).rejects.toThrow(
    "ambiguous timeout",
  )
  connection().metadata = JSON.parse(JSON.stringify(connection().metadata))
  failPost = false
  await autoResetExpiringCodexQuota(connection())
  expect(redeemIds).toHaveLength(2)
  expect(redeemIds[1]).toBe(redeemIds[0])
})

test("successful consume followed by failed refresh cannot spend twice", async () => {
  keepStale = true
  failAfterPost = true
  await expect(autoResetExpiringCodexQuota(connection())).rejects.toThrow(
    "refresh failed",
  )
  failAfterPost = false
  await autoResetExpiringCodexQuota(connection())
  expect(redeemIds).toHaveLength(1)
})

test("turning the switch off during the fresh read cancels spending", async () => {
  const implementation = proxy.getMockImplementation()!
  proxy.mockImplementation(async (conn, request) => {
    updateSystemConfig({ ...normal, codexAutoReset: false })
    return implementation(conn, request)
  })
  await autoResetExpiringCodexQuota(connection())
  expect(redeemIds).toHaveLength(0)
})
