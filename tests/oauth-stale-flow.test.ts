/**
 * 残留 OAuth flow 的自愈（回归测试）。
 *
 * 线上事故：管理端会话只在内存里，服务一重启浏览器那张 cookie 就失效 →
 * 正在进行的重新认证 poll 拿到 403 → flow 永远停在 pending；而它占着 provider
 * 级互斥，之后每次点"重新认证"都返回
 * `An OAuth flow for codex is already in progress.`(409)。flow 是持久化到
 * pending_oauth_flows.json 的，重启也不自愈，用户只能干等 15 分钟 TTL。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import {
  OAUTH_FLOW_REPLACE_AFTER_MS,
  getOAuthFlow,
  registerOAuthFlow,
  resetOAuthFlowsForTest,
} from "~/services/oauth/flows"
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
const testDir = path.join(process.cwd(), ".tmp-oauth-stale-flow")

function fetchTarget(url: string | URL | Request): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.toString()
  return url.url
}

async function adminJson(url: string, init?: RequestInit): Promise<Response> {
  const headers = adminHeaders(init?.headers)
  headers.set("content-type", "application/json")
  return await server.fetch(new Request(url, { ...init, headers }))
}

/** 造一个"没人再 poll"的残留 flow。 */
function registerStaleFlow(
  provider: "kimi" | "codex",
  overrides: Partial<Parameters<typeof registerOAuthFlow>[0]> = {},
): string {
  const id = `stale-${provider}-${Math.random().toString(16).slice(2, 8)}`
  registerOAuthFlow({
    id,
    provider,
    label: "stale",
    status: "pending",
    expiresAt: Date.now() + 10 * 60_000,
    createdAt: Date.now() - OAUTH_FLOW_REPLACE_AFTER_MS - 1_000,
    authUrl: "https://example.invalid/auth",
    ...overrides,
  })
  return id
}

function stubFetch(): void {
  globalThis.fetch = ((url: string | URL | Request) => {
    const target = fetchTarget(url)
    if (target.includes("device_authorization")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "device-stale-1",
            user_code: "STAL-1234",
            verification_uri_complete: "https://auth.kimi.com/device",
            expires_in: 600,
            interval: 5,
          }),
          { status: 200 },
        ),
      )
    }
    if (target.includes("token")) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 200,
        }),
      )
    }
    return Promise.resolve(new Response("{}", { status: 404 }))
  }) as unknown as typeof fetch
}

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true })
  redirectPathsToDir(testDir)
  await fs.writeFile(PATHS.PENDING_OAUTH_FLOWS_PATH, "{}")
  initializeProviderRegistry()
  statsStore.clearUsageStatsForTest()
  setTestAccounts([])
  state.users = []
  state.legacyApiKey = undefined
  state.adminPassword = undefined
  clearAdminPasswordConfig()
  setupAdminAuth()
})

afterEach(async () => {
  resetOAuthFlowsForTest()
  setTestAccounts([])
  globalThis.fetch = originalFetch
  redirectPathsToDir(isolationRoot)
  clearAdminAuth()
  clearAdminPasswordConfig()
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined)
})

describe("残留 OAuth flow 不阻塞重新认证", () => {
  test("超过替换窗口的残留 pending flow 会被新的 start 替换（kimi）", async () => {
    stubFetch()
    const staleId = registerStaleFlow("kimi")

    const response = await adminJson(
      "http://localhost/admin/api/oauth/kimi/start",
      { method: "POST", body: JSON.stringify({ label: "kimi-restart" }) },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { flowId: string }
    expect(body.flowId).not.toBe(staleId)
    expect(getOAuthFlow(staleId)).toBeUndefined()
  })

  test("codex 同理：残留 flow 不再让重新认证永远 409", async () => {
    stubFetch()
    const staleId = registerStaleFlow("codex")

    const response = await adminJson(
      "http://localhost/admin/api/oauth/codex/start",
      { method: "POST", body: JSON.stringify({ label: "codex-restart" }) },
    )

    expect(response.status).toBe(200)
    expect(getOAuthFlow(staleId)).toBeUndefined()
  })

  test("刚创建的 pending flow 仍然互斥（409），不破坏原有的防重复提交", async () => {
    stubFetch()
    const freshId = registerStaleFlow("kimi", { createdAt: Date.now() })

    const response = await adminJson(
      "http://localhost/admin/api/oauth/kimi/start",
      { method: "POST", body: JSON.stringify({ label: "kimi-second" }) },
    )

    expect(response.status).toBe(409)
    expect(getOAuthFlow(freshId)).toBeDefined()
  })

  test("正在兑换 token（exchanging）的 flow 永不被替换", async () => {
    stubFetch()
    const exchangingId = registerStaleFlow("kimi", { status: "exchanging" })

    const response = await adminJson(
      "http://localhost/admin/api/oauth/kimi/start",
      { method: "POST", body: JSON.stringify({ label: "kimi-third" }) },
    )

    expect(response.status).toBe(409)
    expect(getOAuthFlow(exchangingId)).toBeDefined()
  })
})
