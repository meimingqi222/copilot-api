import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import { listTestAccounts as listAccounts } from "./helpers/set-accounts"
import { state } from "~/lib/state"
import type { ProviderConnection } from "~/lib/provider-connections"
import {
  getProviderConnection,
  isAccountManagedConnection,
  listProviderConnections,
  removeProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

import {
  adminRequest,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"
import { setTestAccounts } from "./helpers/set-accounts"

type PerformanceRow = {
  model: string
  requests: number
  streamingRequests: number
  avgTtftMs: number | null
  avgStreamingTps: number | null
  avgDecodeTps: number | null
  decodeSamples: number
  avgNonStreamingTps: number | null
}

type PerformanceResponse = {
  details: Array<{
    connectionId: string
    connectionName: string
    endpoint: string
    transport: string
    translated: boolean
    generationTps: number | null
    timings: { preprocessingMs: { samples: number; average: number | null } }
  }>
  performance: Array<PerformanceRow>
  byProvider: Array<
    PerformanceRow & {
      provider: string
      providerId: string
      providerLabel: string
    }
  >
}

const originalAccounts = listAccounts()
const originalApiKey = state.legacyApiKey
const originalAdminPassword = state.adminPassword
const originalUsers = state.users
test("performance details show live connection names and deleted connection fallback", async () => {
  const connection = getProviderConnection("account-1")
  if (!connection) throw new Error("Missing test connection")
  upsertProviderConnection({ ...connection, name: "Command Code" })
  const timestamp = Date.now()
  for (const connectionId of ["account-1", "account-2", "deleted-endpoint"]) {
    statsStore.recordUsage({
      accountId: "legacy-owner",
      connectionId,
      provider: "openai-compatible",
      model: "deepseek-v4.1-flash",
      date: statsStore.getDateString(timestamp),
      timestamp,
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      streaming: true,
      performance: {
        version: 1,
        endpoint: "/v1/chat/completions",
        transport: "http",
        translated: false,
      },
    })
  }
  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )
  const body = (await response.json()) as PerformanceResponse
  expect(
    body.details.map((row) => [row.connectionId, row.connectionName]),
  ).toEqual([
    ["account-1", "Command Code"],
    ["account-2", "edu"],
    ["deleted-endpoint", "OpenAI Compatible"],
  ])
  upsertProviderConnection({ ...connection, name: "Renamed Command Code" })
  const renamed = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )
  expect(
    ((await renamed.json()) as PerformanceResponse).details[0]?.connectionName,
  ).toBe("Renamed Command Code")
})
test("performance cache reuses unchanged data and invalidates immediately after writes and reset", async () => {
  const probe = spyOn(statsStore, "getPerformanceInRange")
  const request = () =>
    server.fetch(
      adminRequest("http://localhost/admin/api/usage/performance?range=all"),
    )
  const timestamp = Date.now()
  const usage = {
    date: statsStore.getDateString(timestamp),
    accountId: "account-1",
    model: "cache-model",
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    timestamp,
    tps: 10,
    streaming: true,
  }
  try {
    statsStore.recordUsage(usage)
    await request()
    await request()
    expect(probe).toHaveBeenCalledTimes(1)
    statsStore.recordUsage(usage)
    const updated = (await (await request()).json()) as PerformanceResponse
    expect(updated.performance[0]?.requests).toBe(2)
    expect(probe).toHaveBeenCalledTimes(2)
    statsStore.clearUsageStatsForTest()
    const empty = (await (await request()).json()) as PerformanceResponse
    expect(empty.performance).toHaveLength(0)
    expect(probe).toHaveBeenCalledTimes(3)
  } finally {
    probe.mockRestore()
  }
})
beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  setTestAccounts([
    {
      id: "account-1",
      label: "default",
      provider: "copilot",
      credentials: { githubToken: "gh-test-token-1" },
      runtimeState: { copilotToken: "copilot-token-1" },
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
    },
    {
      id: "account-2",
      label: "edu",
      provider: "copilot",
      credentials: { githubToken: "gh-test-token-2" },
      runtimeState: { copilotToken: "copilot-token-2" },
      enabled: true,
      priority: 1,
      isExhausted: false,
      createdAt: Date.now(),
    },
  ])
  state.legacyApiKey = undefined
  state.adminPassword = undefined
  state.users = []
  clearAdminPasswordConfig()
  setupAdminAuth()
})

test("performance API exposes segmented new samples without inventing historical values", async () => {
  const timestamp = Date.now()
  const usage = {
    date: statsStore.getDateString(timestamp),
    accountId: "account-1",
    model: "gpt-test",
    promptTokens: 10,
    completionTokens: 300,
    totalTokens: 310,
    timestamp,
    streaming: true,
    tps: 30,
  }
  statsStore.recordUsage(usage)
  statsStore.recordUsage({
    ...usage,
    performance: {
      version: 1,
      endpoint: "/v1/messages",
      transport: "http",
      translated: true,
      generationMs: 2000,
      preprocessingMs: 12,
    },
  })
  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as PerformanceResponse
  expect(body.details).toHaveLength(1)
  expect(body.details[0]).toMatchObject({
    endpoint: "/v1/messages",
    transport: "http",
    translated: true,
    generationTps: 150,
    timings: { preprocessingMs: { samples: 1, average: 12 } },
  })
  expect(body.performance[0]?.avgStreamingTps).toBe(30)
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  setTestAccounts(originalAccounts)
  // setTestAccounts 只清理 account-managed 连接；测试里临时插进来的 plain
  // connection 必须自己收尾，否则会漏进下一个用例。
  for (const conn of listProviderConnections()) {
    if (!isAccountManagedConnection(conn)) removeProviderConnection(conn.id)
  }
  state.legacyApiKey = originalApiKey
  state.adminPassword = originalAdminPassword
  state.users = originalUsers
  clearAdminAuth()
  clearAdminPasswordConfig()
})

test("GET /admin/api/usage/performance uses a weighted TPS average", async () => {
  const ts = new Date("2026-05-23T08:00:00.000Z").getTime()

  statsStore.recordUsage({
    date: "2026-05-23",
    accountId: "account-1",
    model: "mimo-v2.5-pro",
    promptTokens: 100,
    completionTokens: 100,
    totalTokens: 200,
    cost: 1,
    timestamp: ts,
    ttftMs: 120,
    tps: 10,
    streaming: true,
  })
  statsStore.recordUsage({
    date: "2026-05-23",
    accountId: "account-1",
    model: "mimo-v2.5-pro",
    promptTokens: 10,
    completionTokens: 1,
    totalTokens: 11,
    cost: 0.1,
    timestamp: ts + 1,
    ttftMs: 240,
    tps: 10000,
    streaming: true,
  })
  statsStore.recordUsage({
    date: "2026-05-23",
    accountId: "account-2",
    model: "mimo-v2.5-pro",
    promptTokens: 50,
    completionTokens: 50,
    totalTokens: 100,
    cost: 0.5,
    timestamp: ts + 2,
    ttftMs: 180,
    tps: 5,
    streaming: false,
  })

  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as PerformanceResponse
  expect(body.performance).toHaveLength(1)
  expect(body.performance[0]).toMatchObject({
    model: "mimo-v2.5-pro",
    requests: 3,
    streamingRequests: 2,
    avgTtftMs: 180,
    avgNonStreamingTps: 5,
  })
  expect(body.performance[0].avgStreamingTps).toBeCloseTo(10.1, 1)
})

test("GET /admin/api/usage/performance reports decode TPS without TTFT", async () => {
  const ts = new Date("2026-05-24T08:00:00.000Z").getTime()
  const base = {
    date: "2026-05-24",
    accountId: "account-1",
    model: "decode-tps-model",
    promptTokens: 10,
    // 端到端 30 tok/s 含 8.3s 首字等待；首输出后只有 2s → 150 tok/s
    completionTokens: 300,
    totalTokens: 310,
    timestamp: ts,
    ttftMs: 8300,
    tps: 30,
    streaming: true,
  }
  const metrics = (generationMs: number) => ({
    version: 1 as const,
    endpoint: "/v1/chat/completions",
    transport: "http" as const,
    translated: false,
    generationMs,
  })
  statsStore.recordUsage({ ...base, performance: metrics(2000) })
  // 只有旧口径的行：没有首输出边界，不参与解码 TPS
  statsStore.recordUsage({ ...base, timestamp: ts + 1 })
  // 单帧突发 1ms 会算出 300000 tok/s，须用持久化 tps 校准回 10s
  statsStore.recordUsage({
    ...base,
    timestamp: ts + 2,
    performance: metrics(1),
  })

  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as PerformanceResponse
  const row = body.performance.find((it) => it.model === "decode-tps-model")
  expect(row?.requests).toBe(3)
  // 两列的分母不同，覆盖样本也不同
  expect(row?.avgStreamingTps).toBeCloseTo(30, 5)
  expect(row?.decodeSamples).toBe(2)
  expect(row?.avgDecodeTps).toBeCloseTo(600 / 12, 5)
  expect(
    body.byProvider.find((it) => it.model === "decode-tps-model")?.avgDecodeTps,
  ).toBeCloseTo(600 / 12, 5)
})

test("GET /admin/api/usage/performance splits the same model by provider", async () => {
  const ts = new Date("2026-05-23T08:00:00.000Z").getTime()

  statsStore.recordUsage({
    date: "2026-05-23",
    accountId: "account-1",
    model: "same-model",
    provider: "copilot",
    promptTokens: 10,
    completionTokens: 100,
    totalTokens: 110,
    cost: 0,
    timestamp: ts,
    ttftMs: 400,
    tps: 50,
    streaming: true,
  })
  statsStore.recordUsage({
    date: "2026-05-23",
    accountId: "account-2",
    model: "same-model",
    provider: "codebuddy",
    promptTokens: 10,
    completionTokens: 100,
    totalTokens: 110,
    cost: 0,
    timestamp: ts + 1,
    ttftMs: 1200,
    tps: 25,
    streaming: true,
  })

  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as PerformanceResponse
  // 汇总行仍合并（平均 TTFT 把差距抹平），明细行按 provider 拆开
  expect(body.performance).toHaveLength(1)
  expect(body.performance[0].avgTtftMs).toBe(800)
  expect(body.byProvider).toHaveLength(2)
  const copilot = body.byProvider.find((row) => row.provider === "copilot")
  const codebuddy = body.byProvider.find((row) => row.provider === "codebuddy")
  expect(copilot).toMatchObject({
    model: "same-model",
    requests: 1,
    avgTtftMs: 400,
    avgStreamingTps: 50,
    providerLabel: "GitHub Copilot",
  })
  expect(codebuddy).toMatchObject({
    model: "same-model",
    requests: 1,
    avgTtftMs: 1200,
    avgStreamingTps: 25,
    providerLabel: "CodeBuddy",
  })
})

test("GET /admin/api/usage/performance counts untimed requests, averages only timed ones", async () => {
  const ts = new Date("2026-05-23T08:00:00.000Z").getTime()

  // Timed streaming row.
  statsStore.recordUsage({
    date: "2026-05-23",
    accountId: "account-1",
    model: "mixed-model",
    provider: "copilot",
    promptTokens: 10,
    completionTokens: 100,
    totalTokens: 110,
    cost: 0,
    timestamp: ts,
    ttftMs: 300,
    tps: 20,
    streaming: true,
  })
  // Untimed row (e.g. a usage-missing fallback): still a request, but it must
  // not skew the TTFT/TPS averages.
  statsStore.recordUsage({
    date: "2026-05-23",
    accountId: "account-1",
    model: "mixed-model",
    provider: "copilot",
    promptTokens: 10,
    completionTokens: 0,
    totalTokens: 10,
    cost: 0,
    timestamp: ts + 1,
  })

  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as PerformanceResponse
  expect(body.performance[0]).toMatchObject({
    model: "mixed-model",
    requests: 2,
    streamingRequests: 1,
    avgTtftMs: 300,
    avgStreamingTps: 20,
  })
  // The by-provider breakdown follows the same counting rule.
  expect(body.byProvider[0]).toMatchObject({
    provider: "copilot",
    model: "mixed-model",
    requests: 2,
    streamingRequests: 1,
  })
})

// ── plain connection 的供应商名 ──────────────────────────────────
// `provider` 列对 plain connection 存的是 protocol（openai-compatible），
// 不是服务商。汇总必须下沉到 connection，否则 DeepSeek / 火山引擎 /
// AiHubMix 全塌成一个「OpenAI Compatible」。

let plainConnectionSeq = 0

function addPlainConnection(name: string): string {
  const id = `plain-${++plainConnectionSeq}`
  const connection: ProviderConnection = {
    id,
    name,
    protocol: "openai-compatible",
    baseUrl: "https://plain.invalid/v1",
    enabled: true,
    priority: 10,
    credentials: [
      {
        id: `${id}-cred`,
        label: "key",
        authMode: "bearer",
        value: "sk-test",
        enabled: true,
        priority: 0,
        status: "ready",
        createdAt: Date.now(),
      },
    ],
    createdAt: Date.now(),
  }
  upsertProviderConnection(connection)
  return id
}

function recordPlainUsage(
  connectionId: string,
  model: string,
  ttftMs: number,
): void {
  const timestamp = Date.now()
  statsStore.recordUsage({
    date: statsStore.getDateString(timestamp),
    accountId: connectionId,
    connectionId,
    provider: "openai-compatible",
    model,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    timestamp,
    ttftMs,
    tps: 50,
    streaming: true,
  })
}

test("performance by-provider names the real upstream instead of the protocol", async () => {
  const deepseek = addPlainConnection("DeepSeek (深度求索)")
  recordPlainUsage(deepseek, "deepseek-v4.1-flash", 400)

  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )
  const body = (await response.json()) as PerformanceResponse
  const row = body.byProvider.find((it) => it.model === "deepseek-v4.1-flash")
  expect(row).toBeDefined()
  // 标签是连接名（默认就是预设的服务商名），不再是 "OpenAI Compatible"。
  expect(row?.providerLabel).toBe("DeepSeek (深度求索)")
  expect(row?.provider).toBe(`connection:${deepseek}`)
  expect(row?.providerId).toBe("openai-compatible")
})

test("performance by-provider keeps distinct upstreams apart instead of merging them", async () => {
  const deepseek = addPlainConnection("DeepSeek (深度求索)")
  const volcengine = addPlainConnection("火山引擎 (豆包)")
  // 两个不同上游服务同一个模型：必须拆成两行，不能混在一起求均值。
  recordPlainUsage(deepseek, "shared-model", 200)
  recordPlainUsage(volcengine, "shared-model", 2000)

  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )
  const body = (await response.json()) as PerformanceResponse
  const rows = body.byProvider.filter((it) => it.model === "shared-model")
  expect(rows).toHaveLength(2)
  expect(rows.map((it) => it.providerLabel).sort()).toEqual([
    "DeepSeek (深度求索)",
    "火山引擎 (豆包)",
  ])
  // 各自只含自己的样本，没有被对方的 2000ms 拖均值。
  expect(
    rows.find((it) => it.providerLabel === "DeepSeek (深度求索)")?.avgTtftMs,
  ).toBe(200)
  expect(
    rows.find((it) => it.providerLabel === "火山引擎 (豆包)")?.avgTtftMs,
  ).toBe(2000)
})

test("performance by-provider falls back to the protocol label for deleted upstreams", async () => {
  const gone = addPlainConnection("AiHubMix")
  recordPlainUsage(gone, "gpt-4o-mini", 300)
  // 连接删掉后无法归因：仍旧按 protocol 合并，显示层退回协议标签。
  removeProviderConnection(gone)

  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/performance?range=all"),
  )
  const body = (await response.json()) as PerformanceResponse
  const row = body.byProvider.find((it) => it.model === "gpt-4o-mini")
  expect(row?.providerLabel).toBe("OpenAI Compatible")
  expect(row?.provider).toBe("openai-compatible")
})

test("usage summary names the single upstream behind a compatible protocol", async () => {
  const cline = addPlainConnection("Cline Pass")
  recordPlainUsage(cline, "gpt-4o-mini", 300)

  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/summary?range=all"),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    byProvider: Record<string, { label: string }>
  }
  expect(body.byProvider["openai-compatible"]?.label).toBe("Cline Pass")
})

test("usage summary keeps the protocol label when a protocol serves several upstreams", async () => {
  const cline = addPlainConnection("Cline Pass")
  const aihubmix = addPlainConnection("AiHubMix")
  recordPlainUsage(cline, "gpt-4o-mini", 300)
  recordPlainUsage(aihubmix, "gpt-4o-mini", 900)

  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/usage/summary?range=all"),
  )
  const body = (await response.json()) as {
    byProvider: Record<string, { label: string }>
  }
  // 混合汇总点名会把 A 的用量安到 B 头上，保留协议标签；具体上游在嵌套行里。
  expect(body.byProvider["openai-compatible"]?.label).toBe("OpenAI Compatible")
})

test.each(["deleted", "unnamed", "same-name"])(
  "usage summary keeps mixed upstreams unattributed: %s",
  async (otherState) => {
    const live = addPlainConnection("DeepSeek")
    const other = addPlainConnection(
      otherState === "same-name" ? "DeepSeek" : "Other",
    )
    recordPlainUsage(live, "shared-model", 300)
    recordPlainUsage(other, "shared-model", 900)
    if (otherState === "deleted") removeProviderConnection(other)
    if (otherState === "unnamed") {
      upsertProviderConnection({
        ...getProviderConnection(other)!,
        name: "   ",
      })
    }

    const response = await server.fetch(
      adminRequest("http://localhost/admin/api/usage/summary?range=all"),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      byProvider: Record<
        string,
        {
          label: string
          requests: number
          accounts: Record<string, { requests: number; deleted?: boolean }>
        }
      >
    }
    const bucket = body.byProvider["openai-compatible"]!
    expect(bucket.label).toBe("OpenAI Compatible")
    expect(bucket.requests).toBe(2)
    expect(Object.keys(bucket.accounts).sort()).toEqual([live, other].sort())
    expect(bucket.accounts[other]?.requests).toBe(1)
    if (otherState === "deleted")
      expect(bucket.accounts[other]?.deleted).toBe(true)
  },
)

// ── 性能趋势接口测试 ──────────────────────────────────────────────

test("GET /admin/api/usage/performance/trend returns continuous slot series for a model", async () => {
  const baseTime = Date.now() - 3600 * 1000 * 5
  statsStore.recordUsage({
    date: statsStore.getDateString(baseTime),
    accountId: "test-acc",
    provider: "openai-compatible",
    model: "trend-model",
    promptTokens: 10,
    completionTokens: 100,
    totalTokens: 110,
    timestamp: baseTime,
    ttftMs: 500,
    tps: 50,
    streaming: true,
  })
  statsStore.recordUsage({
    date: statsStore.getDateString(baseTime + 3600 * 1000 * 2),
    accountId: "test-acc",
    provider: "openai-compatible",
    model: "trend-model",
    promptTokens: 10,
    completionTokens: 200,
    totalTokens: 210,
    timestamp: baseTime + 3600 * 1000 * 2,
    ttftMs: 300,
    tps: 100,
    streaming: true,
  })

  const response = await server.fetch(
    adminRequest(
      "http://localhost/admin/api/usage/performance/trend?model=trend-model&range=all&intervalMinutes=60",
    ),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    model: string
    intervalMinutes: number
    series: Array<{
      slotTs: number
      requests: number
      avgStreamingTps: number | null
      avgTtftMs: number | null
    }>
  }
  expect(body.model).toBe("trend-model")
  expect(body.series.length).toBeGreaterThanOrEqual(3)

  // 包含有数据的槽
  const activeSlots = body.series.filter((s) => s.requests > 0)
  expect(activeSlots.length).toBe(2)
  expect(activeSlots[0]?.avgStreamingTps).toBe(50)
  expect(activeSlots[0]?.avgTtftMs).toBe(500)
  expect(activeSlots[1]?.avgStreamingTps).toBe(100)
  expect(activeSlots[1]?.avgTtftMs).toBe(300)

  // 包含空隙槽（无请求时为 null）
  const emptySlots = body.series.filter((s) => s.requests === 0)
  expect(emptySlots.length).toBeGreaterThan(0)
  expect(emptySlots[0]?.avgStreamingTps).toBeNull()
})

test("GET /admin/api/usage/performance/trend includes byProvider breakdown for multi-provider models", async () => {
  const deepseek = addPlainConnection("DeepSeek Test")
  const volcengine = addPlainConnection("Volcengine Test")
  recordPlainUsage(deepseek, "multi-upstream-model", 200)
  recordPlainUsage(volcengine, "multi-upstream-model", 800)

  const response = await server.fetch(
    adminRequest(
      "http://localhost/admin/api/usage/performance/trend?model=multi-upstream-model&range=all",
    ),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    model: string
    series: Array<{ requests: number }>
    byProvider?: Array<{
      provider: string
      providerLabel: string
      series: Array<{ requests: number }>
    }>
  }
  expect(body.byProvider).toBeDefined()
  expect(body.byProvider?.length).toBe(2)
  const labels = body.byProvider?.map((p) => p.providerLabel).sort()
  expect(labels).toEqual(["DeepSeek Test", "Volcengine Test"])
})
