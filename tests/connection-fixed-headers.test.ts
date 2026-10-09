/**
 * 端点连接的固定请求头（`ProviderConnection.headers`）回归测试。
 *
 * 与 tests/connection-preset-headers.test.ts 互补：那里锁的是「预设把身份头
 * 交给用户」（预设数据 + 编辑器预填 + adapter 的发现请求），这里锁的是
 * 「探测与真实请求发的是同一套头」这条链路的两端：
 *
 * - `/fetch-models` 的探测不带头部，而保存后的真实请求带头部 —— 表单里
 *   「在线获取模型」能通、保存后却全挂（或反之），用户无从判断哪边可信。
 * - 连通性测试最后一条兜底路径（plain HTTP probe `/models`）也不带头部。
 *
 * Kimi Coding 的 `/coding` 端点按 User-Agent 白名单放行，是这条缺口最直接
 * 的受害者：裸客户端被 403/429 挡掉。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  getProviderConnection,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import { probeModelsEndpoint } from "~/routes/admin/api/provider-connections-helpers"
import { anthropicCompatibleAdapter } from "~/services/protocols/anthropic-compatible"
import { initializeProviderRegistry } from "~/services/providers"

import {
  adminHeaders,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"

const originalFetch = globalThis.fetch
const isolationRoot = PATHS.APP_DIR
const testDir = path.join(process.cwd(), ".tmp-connection-fixed-headers")
const BASE = "http://localhost/admin/api/provider-connections"

/** Kimi Coding 预设的默认请求头（见 ~/lib/provider-presets/domestic-primary）。 */
const KIMI_HEADERS = {
  "User-Agent": "KimiCLI/1.52.0",
  "X-Msh-Platform": "kimi_cli",
  "X-Msh-Version": "1.52.0",
}

interface Captured {
  url: string
  init: RequestInit & { proxy?: string }
}

/** 打桩 fetch 并记录每次调用的 url + init。 */
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

async function adminJson(url: string, init?: RequestInit): Promise<Response> {
  const headers = adminHeaders(init?.headers)
  headers.set("content-type", "application/json")
  return await server.fetch(new Request(url, { ...init, headers }))
}

/** 请求头按大小写不敏感读:适配器写的是上游要求的大小写形式。 */
function sentHeaders(init: RequestInit): Headers {
  return new Headers(init.headers)
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

describe("connection fixed headers", () => {
  test("fetch-models probes with the fixed headers the form would save", async () => {
    const calls = stubUpstreamFetch(() =>
      Response.json({ data: [{ id: "kimi-for-coding" }] }),
    )

    const response = await adminJson(`${BASE}/fetch-models`, {
      method: "POST",
      body: JSON.stringify({
        protocol: "anthropic-compatible",
        baseUrl: "https://api.kimi.com/coding",
        apiKey: "sk-test",
        authMode: "header",
        headerName: "x-api-key",
        headers: KIMI_HEADERS,
      }),
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    const sent = sentHeaders(calls[0]!.init)
    expect(sent.get("User-Agent")).toBe(KIMI_HEADERS["User-Agent"])
    expect(sent.get("X-Msh-Platform")).toBe(KIMI_HEADERS["X-Msh-Platform"])
    // 鉴权头由凭据给出，探测与真实请求一致
    expect(sent.get("x-api-key")).toBe("sk-test")
  })

  test("a stored connection sends its fixed headers on the messages request", async () => {
    const created = await adminJson(BASE, {
      method: "POST",
      body: JSON.stringify({
        name: "kimi-coding",
        protocol: "anthropic-compatible",
        baseUrl: "https://api.kimi.com/coding",
        headers: KIMI_HEADERS,
        credentials: [
          {
            authMode: "header",
            headerName: "x-api-key",
            value: "sk-stored",
            enabled: true,
          },
        ],
      }),
    })
    expect(created.status).toBe(201)
    const { connection } = (await created.json()) as {
      connection: { id: string }
    }

    const calls = stubUpstreamFetch(() =>
      Response.json({ id: "msg_1", content: [] }),
    )

    const stored = getProviderConnection(connection.id)!
    expect(stored.headers).toEqual(KIMI_HEADERS)
    await anthropicCompatibleAdapter.createMessages!({
      connection: stored,
      credential: stored.credentials[0]!,
      target: { upstreamModelId: "kimi-for-coding" } as never,
      payload: {
        model: "kimi-for-coding",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      },
      ctx: {},
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://api.kimi.com/coding/v1/messages")
    const sent = sentHeaders(calls[0]!.init)
    expect(sent.get("User-Agent")).toBe(KIMI_HEADERS["User-Agent"])
    expect(sent.get("X-Msh-Version")).toBe(KIMI_HEADERS["X-Msh-Version"])
    expect(sent.get("x-api-key")).toBe("sk-stored")
  })

  test("the fallback /models probe carries the connection's fixed headers", async () => {
    const calls = stubUpstreamFetch(() => Response.json({ data: [] }))
    const connection: ProviderConnection = {
      id: "probe-conn",
      name: "probe",
      protocol: "anthropic-compatible",
      baseUrl: "https://api.kimi.com/coding",
      enabled: true,
      priority: 0,
      headers: KIMI_HEADERS,
      credentials: [],
      createdAt: 0,
    }
    const credential: ApiCredential = {
      id: "probe-cred",
      authMode: "header",
      headerName: "x-api-key",
      value: "sk-probe",
      enabled: true,
      status: "ready",
      createdAt: 0,
    }

    await probeModelsEndpoint(connection, credential, AbortSignal.timeout(1000))

    expect(calls).toHaveLength(1)
    const sent = sentHeaders(calls[0]!.init)
    expect(sent.get("User-Agent")).toBe(KIMI_HEADERS["User-Agent"])
    expect(sent.get("x-api-key")).toBe("sk-probe")
  })
})
