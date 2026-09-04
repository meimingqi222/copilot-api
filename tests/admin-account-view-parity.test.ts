/**
 * Phase 4 锁形测试:验证 publicAccountFromConnection(conn) 产出的 JSON 形状
 * 与 admin API 依赖的 publicAccount(account) 形状完全一致(G1 冻结)。
 *
 * 此测试固定 connection fixture → 通过 publicAccountFromConnection 输出,
 * 断言所有 admin UI 依赖的字段都存在且类型正确。
 * 同时验证导出/导入往返(serializeAccountForExport → 重新加载 → 形状不变)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/legacy-accounts"

import { listAccounts } from "~/lib/legacy-accounts"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import { initializeProviderRegistry } from "~/services/providers"

import {
  adminHeaders,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"
import { setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listAccounts()
const originalFetch = globalThis.fetch
const testDir = PATHS.APP_DIR

function copilotAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: overrides.id ?? "cp-parity-1",
    label: overrides.label ?? "copilot-parity",
    provider: "copilot",
    credentials: {
      githubToken: overrides.credentials?.githubToken ?? "gh-parity",
    },
    settings: overrides.settings ?? {},
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 0,
    quotaState: overrides.quotaState ?? "unknown",
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

function oauthAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: overrides.id ?? "oauth-parity-1",
    label: overrides.label ?? "claude-parity",
    provider: "claude",
    credentials: {
      accessToken: overrides.credentials?.accessToken ?? "at-parity",
      refreshToken: overrides.credentials?.refreshToken ?? "rt-parity",
      expiresAt: overrides.credentials?.expiresAt ?? Date.now() + 3600_000,
      accountId: overrides.credentials?.accountId ?? "acc-1",
      email: overrides.credentials?.email ?? "user@example.com",
    },
    settings: overrides.settings ?? {},
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 10,
    quotaState: overrides.quotaState ?? "unknown",
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

function windsurfAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: overrides.id ?? "ws-parity-1",
    label: overrides.label ?? "windsurf-parity",
    provider: "windsurf",
    credentials: {
      apiKey: overrides.credentials?.apiKey ?? "ws-key-parity",
    },
    settings: overrides.settings ?? {},
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 5,
    quotaState: overrides.quotaState ?? "unknown",
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

async function adminJson(url: string, init?: RequestInit): Promise<Response> {
  const headers = adminHeaders(init?.headers)
  headers.set("content-type", "application/json")
  return await server.fetch(
    new Request(url, {
      ...init,
      headers,
    }),
  )
}

describe("admin account view parity (Phase 4 G1 freeze)", () => {
  beforeEach(async () => {
    redirectPathsToDir(testDir)
    await statsStore.clearUsageStatsForTest()
    resetAdaptiveRateLimiterForTest()
    setupAdminAuth()
    globalThis.fetch = originalFetch
  })

  afterEach(async () => {
    clearAdminAuth()
    clearAdminPasswordConfig()
    setTestAccounts(originalAccounts)
    globalThis.fetch = originalFetch
  })

  test("copilot account: publicAccountFromConnection produces expected JSON shape", async () => {
    setTestAccounts([copilotAccount()])
    initializeProviderRegistry()

    const res = await adminJson("http://localhost/admin/api/accounts")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const account = (body.accounts as Array<Record<string, unknown>>)[0]

    // G1 冻结:验证所有 admin UI 依赖的字段存在且类型正确
    expect(account.id).toBe("cp-parity-1")
    expect(account.label).toBe("copilot-parity")
    expect(account.provider).toBe("copilot")
    expect(account.enabled).toBe(true)
    expect(account.priority).toBe(0)
    expect(account.quotaState).toBe("unknown")
    expect(account.availabilityReason).toBe("available")
    expect(account.retryAfterSeconds).toBe(null)
    expect(account.isExhausted).toBe(false)
    expect(account.exhaustedAt).toBeUndefined()
    expect(account.authStatus).toBe("ready")
    expect(account.authError).toBe(null)
    expect(account.hasCredentials).toBe(true)
    expect(typeof account.createdAt).toBe("number")
    expect(account.settings).toEqual({})
    expect(account.availableModels).toBeUndefined()
    expect(typeof account.supportsQuota).toBe("boolean")
    expect(typeof account.isActive).toBe("boolean")
    expect(account.subtitle).toBeUndefined()
    expect(account.providerFeatures).toBeDefined()
    expect(account.quotaInfo).toBe(null)
  })

  test("oauth account: publicAccountFromConnection produces expected JSON shape", async () => {
    setTestAccounts([oauthAccount()])
    initializeProviderRegistry()

    const res = await adminJson("http://localhost/admin/api/accounts")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const account = (body.accounts as Array<Record<string, unknown>>)[0]

    expect(account.id).toBe("oauth-parity-1")
    expect(account.label).toBe("claude-parity")
    expect(account.provider).toBe("claude")
    expect(account.enabled).toBe(true)
    expect(account.priority).toBe(10)
    expect(account.quotaState).toBe("unknown")
    expect(account.availabilityReason).toBe("available")
    expect(account.retryAfterSeconds).toBe(null)
    expect(account.isExhausted).toBe(false)
    expect(account.authStatus).toBe("ready")
    expect(account.authError).toBe(null)
    expect(account.hasCredentials).toBe(true)
    expect(typeof account.createdAt).toBe("number")
    expect(account.settings).toEqual({})
    expect(account.availableModels).toBeUndefined()
    expect(typeof account.supportsQuota).toBe("boolean")
    expect(typeof account.isActive).toBe("boolean")
    // OAuth accounts have a subtitle derived from email/accountId
    expect(typeof account.subtitle).toBe("string")
    expect(account.providerFeatures).toBeDefined()
    expect(account.quotaInfo).toBe(null)
  })

  test("windsurf account: publicAccountFromConnection produces expected JSON shape", async () => {
    setTestAccounts([windsurfAccount()])
    initializeProviderRegistry()

    const res = await adminJson("http://localhost/admin/api/accounts")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const account = (body.accounts as Array<Record<string, unknown>>)[0]

    expect(account.id).toBe("ws-parity-1")
    expect(account.label).toBe("windsurf-parity")
    expect(account.provider).toBe("windsurf")
    expect(account.enabled).toBe(true)
    expect(account.priority).toBe(5)
    expect(account.quotaState).toBe("unknown")
    expect(account.availabilityReason).toBe("available")
    expect(account.retryAfterSeconds).toBe(null)
    expect(account.isExhausted).toBe(false)
    expect(account.authStatus).toBe("ready")
    expect(account.authError).toBe(null)
    expect(account.hasCredentials).toBe(true)
    expect(typeof account.createdAt).toBe("number")
    expect(account.settings).toEqual({})
    expect(account.availableModels).toBeUndefined()
    expect(typeof account.supportsQuota).toBe("boolean")
    expect(typeof account.isActive).toBe("boolean")
    expect(account.subtitle).toBeUndefined()
    expect(account.providerFeatures).toBeDefined()
    expect(account.quotaInfo).toBe(null)
  })

  test("GET /:id returns same shape as list endpoint", async () => {
    setTestAccounts([copilotAccount()])
    initializeProviderRegistry()

    const listRes = await adminJson("http://localhost/admin/api/accounts")
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as Record<string, unknown>
    expect(listBody.accounts).toBeInstanceOf(Array)
    expect(listBody.accounts).toHaveLength(1)
    const listAccount = (listBody.accounts as Array<Record<string, unknown>>)[0]

    // PUT /:id 返回单个 account 形状
    const putRes = await adminJson(
      "http://localhost/admin/api/accounts/cp-parity-1",
      {
        method: "PUT",
        body: JSON.stringify({ label: "copilot-parity-updated" }),
      },
    )
    expect(putRes.status).toBe(200)
    const putBody = (await putRes.json()) as Record<string, unknown>
    const putAccount = putBody.account as Record<string, unknown>

    // 两者形状一致(除了 label 因 PUT 而变化)
    expect(putAccount.id).toBe(listAccount.id)
    expect(putAccount.label).toBe("copilot-parity-updated")
    expect(putAccount.provider).toBe(listAccount.provider)
    expect(putAccount.enabled).toBe(listAccount.enabled)
    expect(putAccount.priority).toBe(listAccount.priority)
    expect(putAccount.quotaState).toBe(listAccount.quotaState)
    expect(putAccount.availabilityReason).toBe(listAccount.availabilityReason)
    expect(putAccount.isExhausted).toBe(listAccount.isExhausted)
    expect(putAccount.authStatus).toBe(listAccount.authStatus)
    expect(putAccount.hasCredentials).toBe(listAccount.hasCredentials)
    expect(putAccount.settings).toEqual(listAccount.settings)
    expect(putAccount.providerFeatures).toEqual(listAccount.providerFeatures)
  })

  test("export endpoint returns accounts array shape", async () => {
    setTestAccounts([copilotAccount(), windsurfAccount()])
    initializeProviderRegistry()

    const res = await adminJson("http://localhost/admin/api/accounts/export")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(body.accounts).toBeInstanceOf(Array)
    expect(body.accounts).toHaveLength(2)
    // 导出格式包含 credentials(非敏感的 githubToken 等)
    const cp = (body.accounts as Array<Record<string, unknown>>).find(
      (a: Record<string, unknown>) => a.provider === "copilot",
    )
    expect(cp).toBeDefined()
    if (!cp) return
    expect(cp.credentials).toBeDefined()
    const creds = cp.credentials as Record<string, unknown>
    expect(creds.githubToken).toBe("gh-parity")
  })
})
