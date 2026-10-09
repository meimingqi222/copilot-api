/**
 * 端点连接（非账户连接）的 `proxyUrl` 端到端回归测试。
 *
 * 背景：运行时是 Bun，连接级代理只能靠 Bun 原生 fetch 的 `proxy` 选项
 * （`~/lib/proxy` 的 undici dispatcher 在 Bun 下是空操作）。adapter 侧的透传
 * 由 tests/connection-proxy-wiring.test.ts 覆盖；这里覆盖"能不能配上"这条
 * 链路：CRUD 路由、落库、导出/导入往返、以及实时模型探测。
 *
 * 缺口曾经是：`ProviderConnection.proxyUrl` 是类型化字段、OAuth 流程会写它，
 * 但端点连接 API 完全不接受它 —— 手动建的连接（如 stepfun）永远拿不到代理。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"
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

const originalFetch = globalThis.fetch
const isolationRoot = PATHS.APP_DIR
const testDir = path.join(process.cwd(), ".tmp-provider-conn-proxy-url")
const PROXY = "http://proxy.example.invalid:8080"

interface Captured {
  url: string
  init: RequestInit & { proxy?: string }
}

async function adminJson(url: string, init?: RequestInit): Promise<Response> {
  const headers = adminHeaders(init?.headers)
  headers.set("content-type", "application/json")
  return await server.fetch(new Request(url, { ...init, headers }))
}

const BASE = "http://localhost/admin/api/provider-connections"

async function createConnectionViaApi(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await adminJson(BASE, {
    method: "POST",
    body: JSON.stringify({
      name: "stepfun",
      protocol: "openai-compatible",
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      ...body,
    }),
  })
  expect(response.status).toBe(201)
  const payload = (await response.json()) as {
    connection: Record<string, unknown>
  }
  return payload.connection
}

function stubUpstreamFetch(
  respond: (url: string, callIndex: number) => Response,
): Array<Captured> {
  const calls: Array<Captured> = []
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const index = calls.length
      calls.push({
        url: String(url),
        init: (init ?? {}) as Captured["init"],
      })
      return respond(String(url), index)
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  return calls
}

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true })
  redirectPathsToDir(testDir)
  __resetProviderConnectionsForTest()
  initializeProviderRegistry()
  statsStore.clearUsageStatsForTest()
  state.users = []
  state.legacyApiKey = undefined
  clearAdminPasswordConfig()
  setupAdminAuth()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  redirectPathsToDir(isolationRoot)
  resetAdaptiveRateLimiterForTest()
  clearAdminAuth()
  clearAdminPasswordConfig()
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined)
})

describe("provider connection proxyUrl persistence", () => {
  test("POST stores proxyUrl and GET returns it", async () => {
    const created = await createConnectionViaApi({ proxyUrl: PROXY })
    expect(created.proxyUrl).toBe(PROXY)

    const response = await adminJson(`${BASE}/${String(created.id)}`, {
      method: "GET",
    })
    const { connection } = (await response.json()) as {
      connection: { proxyUrl?: string }
    }
    expect(connection.proxyUrl).toBe(PROXY)
  })

  test("POST without proxyUrl leaves the field unset", async () => {
    const created = await createConnectionViaApi({})
    expect(created.proxyUrl).toBeUndefined()
  })

  test("PUT sets and then clears proxyUrl (empty string means clear)", async () => {
    const created = await createConnectionViaApi({})
    const id = String(created.id)

    const setResponse = await adminJson(`${BASE}/${id}`, {
      method: "PUT",
      body: JSON.stringify({ proxyUrl: PROXY }),
    })
    expect(setResponse.status).toBe(200)
    expect(
      ((await setResponse.json()) as { connection: { proxyUrl?: string } })
        .connection.proxyUrl,
    ).toBe(PROXY)

    const clearResponse = await adminJson(`${BASE}/${id}`, {
      method: "PUT",
      body: JSON.stringify({ proxyUrl: "" }),
    })
    expect(
      ((await clearResponse.json()) as { connection: { proxyUrl?: string } })
        .connection.proxyUrl,
    ).toBeUndefined()
  })

  test("export → import round-trip keeps proxyUrl", async () => {
    const created = await createConnectionViaApi({ proxyUrl: PROXY })
    const id = String(created.id)

    const exported = await adminJson(`${BASE}/${id}/export`, { method: "GET" })
    expect(exported.status).toBe(200)
    const payload = (await exported.json()) as unknown
    expect(
      (payload as { connections: Array<{ proxyUrl?: string }> }).connections[0]
        ?.proxyUrl,
    ).toBe(PROXY)

    const deleted = await adminJson(`${BASE}/${id}`, { method: "DELETE" })
    expect(deleted.status).toBe(200)

    const imported = await adminJson(`${BASE}/import`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    expect(imported.status).toBe(200)

    const restored = await adminJson(`${BASE}/${id}`, { method: "GET" })
    const { connection } = (await restored.json()) as {
      connection: { proxyUrl?: string }
    }
    expect(connection.proxyUrl).toBe(PROXY)
  })
})

describe("provider connection proxyUrl usage", () => {
  test("fetch-models probes through the connection proxy", async () => {
    const calls = stubUpstreamFetch(() =>
      Response.json({ data: [{ id: "step-2-mini" }] }),
    )

    const response = await adminJson(`${BASE}/fetch-models`, {
      method: "POST",
      body: JSON.stringify({
        protocol: "openai-compatible",
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        apiKey: "sk-test",
        proxyUrl: PROXY,
      }),
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.stepfun.com/step_plan/v1/models")
    expect(calls[0]?.init.proxy).toBe(PROXY)
  })

  test("test connection routes the adapter probe through the proxy", async () => {
    const created = await createConnectionViaApi({
      proxyUrl: PROXY,
      credentials: [{ value: "sk-test", authMode: "bearer" }],
      models: [
        {
          publicId: "step-2-mini",
          upstreamId: "step-2-mini",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })
    const calls = stubUpstreamFetch(() =>
      Response.json({ choices: [], usage: {} }),
    )

    const response = await adminJson(`${BASE}/${String(created.id)}/test`, {
      method: "POST",
      body: JSON.stringify({ modelId: "step-2-mini" }),
    })

    expect(response.status).toBe(200)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.init.proxy).toBe(PROXY)
    }
  })
})
