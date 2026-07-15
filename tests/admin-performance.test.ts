import { afterEach, beforeEach, expect, test } from "bun:test"

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

type PerformanceRow = {
  model: string
  requests: number
  streamingRequests: number
  avgTtftMs: number | null
  avgStreamingTps: number | null
  avgNonStreamingTps: number | null
}

type PerformanceResponse = {
  performance: Array<PerformanceRow>
}

const originalAccounts = state.accounts
const originalActiveAccountIndex = state.activeAccountIndex
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
  state.activeAccountIndex = 0
  state.legacyApiKey = undefined
  state.adminPassword = undefined
  state.users = []
  clearAdminPasswordConfig()
  setupAdminAuth()
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  setTestAccounts(originalAccounts)
  state.activeAccountIndex = originalActiveAccountIndex
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
