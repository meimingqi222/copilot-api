import { afterEach, beforeEach, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

type UsageMetrics = {
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
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

const originalAccounts = state.accounts
const originalActiveAccountIndex = state.activeAccountIndex
const originalApiKey = state.apiKey
const originalAdminPassword = state.adminPassword
const originalUsers = state.users
const originalProvider = state.provider

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  state.accounts = [
    {
      id: "account-1",
      label: "default",
      provider: "copilot",
      githubToken: "gh-test-token-1",
      copilotToken: "copilot-token-1",
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
    },
    {
      id: "account-2",
      label: "edu",
      provider: "copilot",
      githubToken: "gh-test-token-2",
      copilotToken: "copilot-token-2",
      enabled: true,
      priority: 1,
      isExhausted: false,
      createdAt: Date.now(),
    },
  ]
  state.activeAccountIndex = 0
  state.apiKey = undefined
  state.adminPassword = undefined
  state.users = []
  state.provider = "copilot"
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  state.accounts = originalAccounts
  state.activeAccountIndex = originalActiveAccountIndex
  state.apiKey = originalApiKey
  state.adminPassword = originalAdminPassword
  state.users = originalUsers
  state.provider = originalProvider
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
    new Request(
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
  })

  expect(body.byModel["claude-sonnet-4.6"]).toMatchObject({
    requests: 3,
    promptTokens: 2000,
    completionTokens: 700,
    cacheReadTokens: 250,
    totalTokens: 2950,
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
  })
})
