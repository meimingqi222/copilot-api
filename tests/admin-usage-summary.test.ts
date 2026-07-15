import { afterEach, beforeEach, expect, test } from "bun:test"

import { listAccounts } from "~/lib/accounts"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

import {
  adminRequest,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"
import { setTestAccounts } from "./helpers/set-accounts"

type UsageMetrics = {
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
  inputTokens: number
  cacheHitRate: number | null
}

type UsageSummaryResponse = {
  totals: UsageMetrics
  byModel: Record<string, UsageMetrics>
  byAccount: Record<
    string,
    UsageMetrics & {
      label: string
      models: Record<string, UsageMetrics>
    }
  >
  timeSeries: Array<
    UsageMetrics & {
      date: string
      models: Record<string, UsageMetrics>
    }
  >
}

const originalAccounts = listAccounts()
const originalApiKey = state.legacyApiKey
const originalAdminPassword = state.adminPassword
const originalUsers = state.users
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

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  setTestAccounts(originalAccounts)
  state.legacyApiKey = originalApiKey
  state.adminPassword = originalAdminPassword
  state.users = originalUsers
  clearAdminAuth()
  clearAdminPasswordConfig()
})

test("GET /admin/api/usage/summary returns per-model request counts and time series token breakdown", async () => {
  const dayOne = new Date("2026-03-10T08:00:00.000Z").getTime()
  const dayTwo = new Date("2026-03-11T08:00:00.000Z").getTime()

  statsStore.recordUsage({
    date: "2026-03-10",
    accountId: "account-1",
    model: "claude-sonnet-4.6",
    promptTokens: 1000,
    completionTokens: 400,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
    totalTokens: 1600,
    cost: 1.2,
    timestamp: dayOne,
  })
  statsStore.recordUsage({
    date: "2026-03-10",
    accountId: "account-2",
    model: "gpt-5.4",
    promptTokens: 500,
    completionTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 100,
    totalTokens: 900,
    cost: 0.8,
    timestamp: dayOne + 1,
  })
  statsStore.recordUsage({
    date: "2026-03-11",
    accountId: "account-1",
    model: "claude-sonnet-4.6",
    promptTokens: 800,
    completionTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1000,
    cost: 0.6,
    timestamp: dayTwo,
  })
  statsStore.recordUsage({
    date: "2026-03-11",
    accountId: "account-2",
    model: "claude-sonnet-4.6",
    promptTokens: 200,
    completionTokens: 100,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    totalTokens: 350,
    cost: 0.3,
    timestamp: dayTwo + 1,
  })

  const response = await server.fetch(
    adminRequest(
      "http://localhost/admin/api/usage/summary?startDate=2026-03-10&endDate=2026-03-11",
    ),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as UsageSummaryResponse

  expect(body.totals).toMatchObject({
    requests: 4,
    promptTokens: 2500,
    completionTokens: 1000,
    cacheReadTokens: 250,
    cacheWriteTokens: 100,
    totalTokens: 3850,
    cost: 2.9,
    inputTokens: 2750,
    cacheHitRate: 250 / 2750,
  })

  expect(body.byModel["claude-sonnet-4.6"]).toMatchObject({
    requests: 3,
    promptTokens: 2000,
    completionTokens: 700,
    cacheReadTokens: 250,
    totalTokens: 2950,
    inputTokens: 2250,
    cacheHitRate: 250 / 2250,
  })
  expect(body.byModel["claude-sonnet-4.6"].cost).toBeCloseTo(2.1, 10)
  expect(body.byModel["gpt-5.4"]).toMatchObject({
    requests: 1,
    promptTokens: 500,
    completionTokens: 300,
    cacheWriteTokens: 100,
    totalTokens: 900,
    cost: 0.8,
  })

  expect(body.byAccount["account-1"]).toMatchObject({
    label: "default",
    requests: 2,
    totalTokens: 2600,
  })
  expect(body.byAccount["account-1"].models["claude-sonnet-4.6"]).toMatchObject(
    {
      requests: 2,
      totalTokens: 2600,
      inputTokens: 2000,
      cacheHitRate: 0.1,
    },
  )
  expect(body.byAccount["account-2"].models["gpt-5.4"]).toMatchObject({
    requests: 1,
    totalTokens: 900,
  })

  expect(body.timeSeries).toHaveLength(2)
  expect(body.timeSeries[0]).toMatchObject({
    date: "2026-03-11",
    requests: 2,
    totalTokens: 1350,
  })
  expect(body.timeSeries[0].models["claude-sonnet-4.6"]).toMatchObject({
    requests: 2,
    totalTokens: 1350,
  })
  expect(body.timeSeries[1]).toMatchObject({
    date: "2026-03-10",
    requests: 2,
    totalTokens: 2500,
  })
  expect(body.timeSeries[1].models["gpt-5.4"]).toMatchObject({
    requests: 1,
    totalTokens: 900,
    inputTokens: 500,
    cacheHitRate: 0,
  })
})

test("GET /admin/api/usage/summary returns null cacheHitRate when no input tokens", async () => {
  const timestamp = new Date("2026-03-10T08:00:00.000Z").getTime()

  statsStore.recordUsage({
    date: "2026-03-10",
    accountId: "account-1",
    model: "gpt-5.4",
    promptTokens: 0,
    completionTokens: 120,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 120,
    cost: 0.1,
    timestamp,
  })

  const response = await server.fetch(
    adminRequest(
      "http://localhost/admin/api/usage/summary?startDate=2026-03-10&endDate=2026-03-10",
    ),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as UsageSummaryResponse

  expect(body.totals.cacheHitRate).toBeNull()
  expect(body.totals.inputTokens).toBe(0)
  expect(body.byModel["gpt-5.4"].cacheHitRate).toBeNull()
})

test("GET /admin/api/usage/summary keeps swe-1-6 and swe-1-6-fast separate", async () => {
  const timestamp = new Date("2026-06-27T08:00:00.000Z").getTime()

  statsStore.recordUsage({
    date: "2026-06-27",
    accountId: "account-1",
    model: "swe-1-6",
    promptTokens: 5000,
    completionTokens: 200,
    totalTokens: 5200,
    cost: 0.5,
    timestamp,
  })
  statsStore.recordUsage({
    date: "2026-06-27",
    accountId: "account-1",
    model: "swe-1-6-fast",
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    cost: 0.01,
    timestamp: timestamp + 1,
  })

  const response = await server.fetch(
    adminRequest(
      "http://localhost/admin/api/usage/summary?startDate=2026-06-27&endDate=2026-06-27",
    ),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as UsageSummaryResponse

  expect(body.byModel["swe-1-6"]).toMatchObject({
    requests: 1,
    promptTokens: 5000,
    completionTokens: 200,
    totalTokens: 5200,
  })
  expect(body.byModel["swe-1-6-fast"]).toMatchObject({
    requests: 1,
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
  })
})
