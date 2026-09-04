/**
 * 验证 /admin/api/provider-connections API 过滤 account-derived connection:
 * 导入的账号(copilot/OAuth 等)不应出现在外部 provider 列表中,
 * 也不允许通过外部 provider API 操作(GET/PUT/DELETE /:id)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { Account } from "~/lib/legacy-accounts"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"
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

const originalFetch = globalThis.fetch
const isolationRoot = PATHS.APP_DIR
const testDir = path.join(process.cwd(), ".tmp-admin-conn-filter")

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

function copilotAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: overrides.id ?? "cp-filter-test",
    label: overrides.label ?? "copilot-filter-test",
    provider: "copilot",
    credentials: {
      githubToken: overrides.credentials?.githubToken ?? "gh-test",
    },
    settings: overrides.settings ?? {},
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 0,
    quotaState: overrides.quotaState ?? "unknown",
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true })
  redirectPathsToDir(testDir)
  initializeProviderRegistry()
  statsStore.clearUsageStatsForTest()
  setTestAccounts([])
  state.users = []
  state.legacyApiKey = undefined
  state.adminPassword = undefined
  clearAdminPasswordConfig()
  setupAdminAuth()
  // Stub fetch 避免后台模型/配额刷新访问网络
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("{}", { status: 404 }),
    )) as unknown as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  redirectPathsToDir(isolationRoot)
  resetAdaptiveRateLimiterForTest()
  clearAdminAuth()
  clearAdminPasswordConfig()
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined)
})

describe("provider-connections API filters account-derived connections", () => {
  test("GET /admin/api/provider-connections excludes account-derived connections", async () => {
    // 设置一个 copilot 账号(account-derived connection)和一个普通 connection
    setTestAccounts([copilotAccount({ id: "cp-edu", label: "edu" })])

    // 创建一个普通 provider connection
    await adminJson("http://localhost/admin/api/provider-connections", {
      method: "POST",
      body: JSON.stringify({
        name: "volcengine",
        protocol: "anthropic-compatible",
        baseUrl: "https://api.volcengine.com",
        credentials: [{ value: "sk-test", authMode: "bearer" }],
        models: [
          {
            publicId: "glm-5.2",
            upstreamId: "glm-5.2",
            endpoints: ["messages"],
            enabled: true,
          },
        ],
      }),
    })

    const response = await adminJson(
      "http://localhost/admin/api/provider-connections",
    )
    expect(response.status).toBe(200)
    const data = (await response.json()) as {
      connections: Array<{ id: string }>
    }
    const ids = data.connections.map((c) => c.id)

    // 普通 connection 应出现在列表中
    expect(ids).toContain("volcengine")
    // account-derived connection 不应出现
    expect(ids).not.toContain("cp-edu")
  })

  test("GET /admin/api/provider-connections/:id returns 403 for account-derived connection", async () => {
    setTestAccounts([copilotAccount({ id: "cp-guard", label: "guard-test" })])

    const response = await adminJson(
      "http://localhost/admin/api/provider-connections/cp-guard",
    )
    expect(response.status).toBe(403)
  })

  test("PUT /admin/api/provider-connections/:id returns 403 for account-derived connection", async () => {
    setTestAccounts([copilotAccount({ id: "cp-put", label: "put-test" })])

    const response = await adminJson(
      "http://localhost/admin/api/provider-connections/cp-put",
      {
        method: "PUT",
        body: JSON.stringify({ name: "hacked" }),
      },
    )
    expect(response.status).toBe(403)
  })

  test("DELETE /admin/api/provider-connections/:id returns 403 for account-derived connection", async () => {
    setTestAccounts([copilotAccount({ id: "cp-del", label: "del-test" })])

    const response = await adminJson(
      "http://localhost/admin/api/provider-connections/cp-del",
      { method: "DELETE" },
    )
    expect(response.status).toBe(403)
  })

  test("GET /admin/api/provider-connections/export excludes account-derived connections", async () => {
    setTestAccounts([copilotAccount({ id: "cp-export", label: "export-test" })])

    await adminJson("http://localhost/admin/api/provider-connections", {
      method: "POST",
      body: JSON.stringify({
        name: "openai-direct",
        protocol: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        credentials: [{ value: "sk-test", authMode: "bearer" }],
      }),
    })

    const response = await adminJson(
      "http://localhost/admin/api/provider-connections/export",
    )
    expect(response.status).toBe(200)
    const data = (await response.json()) as {
      connections: Array<{ id: string }>
    }
    const ids = data.connections.map((c) => c.id)

    expect(ids).toContain("openai-direct")
    expect(ids).not.toContain("cp-export")
  })

  test("POST /admin/api/provider-connections rejects *-native protocol", async () => {
    const response = await adminJson(
      "http://localhost/admin/api/provider-connections",
      {
        method: "POST",
        body: JSON.stringify({
          name: "fake-copilot",
          protocol: "copilot-native",
          baseUrl: "https://api.githubcopilot.com",
          credentials: [{ value: "sk-test", authMode: "bearer" }],
        }),
      },
    )
    expect(response.status).toBe(400)
    const data = (await response.json()) as { error: string }
    expect(data.error).toContain("account-managed")
  })

  test("PUT /admin/api/provider-connections/:id rejects changing to *-native protocol", async () => {
    // 先创建一个合法的外部 provider connection
    await adminJson("http://localhost/admin/api/provider-connections", {
      method: "POST",
      body: JSON.stringify({
        name: "openai-test",
        protocol: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        credentials: [{ value: "sk-test", authMode: "bearer" }],
      }),
    })

    // 尝试把 protocol 改成 copilot-native
    const response = await adminJson(
      "http://localhost/admin/api/provider-connections/openai-test",
      {
        method: "PUT",
        body: JSON.stringify({ protocol: "copilot-native" }),
      },
    )
    expect(response.status).toBe(400)
    const data = (await response.json()) as { error: string }
    expect(data.error).toContain("account-managed")
  })
})
