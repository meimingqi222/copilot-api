import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import type { ProviderConnection } from "~/lib/provider-connections"
import {
  managedConnectionFromInput,
  markCredentialCooldown,
  removeProviderConnection,
  setConnectionQuotaState,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import {
  clearAccountRateLimitState,
  reportUpstreamRateLimitMs,
} from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { publishTrace } from "~/lib/trace-bus"
import { server } from "~/server"

import { adminRequest, setupAdminAuth } from "./admin-test-utils"

// 本文件会把 state.users 设成非空用户表；测试进程是共享的，不还原就会污染后续
// 文件：API key 校验会改走用户存储，导致用 legacy key 的请求全部 401
// （实测 tests/messages-route.test.ts 的三条因此失败）。
const originalUsers = state.users

describe("Admin Dashboard API", () => {
  afterEach(() => {
    state.users = originalUsers
  })

  beforeEach(() => {
    setupAdminAuth()
    statsStore.clearUsageStatsForTest()
    state.users = [
      {
        id: "u1",
        username: "test-user",
        hashedApiKey: "hash-1",
        quotaLimit: 1000,
        usedTokens: 0,
        role: "user",
        enabled: true,
        createdAt: Date.now(),
      },
    ]
  })

  test("returns compatible legacy fields and rich operational telemetry", async () => {
    // Record dummy usage and stats
    statsStore.incrementRequests("acc-1")
    statsStore.recordUsage({
      date: statsStore.getDateString(),
      accountId: "acc-1",
      model: "claude-3-7-sonnet",
      promptTokens: 1000,
      completionTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      totalTokens: 1700,
      cost: 0.015,
      timestamp: Date.now(),
      ttftMs: 320,
      tps: 45,
      streaming: true,
    })

    publishTrace({
      requestId: "req-1",
      modelRequested: "claude-3-7-sonnet",
      connectionName: "Claude-CLI",
      latencyMs: 450,
      ttftMs: 320,
      statusCode: 200,
      ok: true,
    })

    const res = await server.fetch(
      adminRequest("http://localhost/admin/api/dashboard"),
    )
    expect(res.status).toBe(200)

    const data = (await res.json()) as Record<string, any>

    // 1. Compatible legacy fields
    expect(data.activeUsers).toBe(1)
    expect(data.totalUsers).toBe(1)
    expect(data.requestsToday).toBeGreaterThanOrEqual(1)
    expect(data.activeAccountQuota).toBeDefined()
    expect(data.totalQuota).toBeDefined()

    // 2. New rich telemetry
    expect(data.metrics).toBeDefined()
    expect(data.metrics.successRate).toBe(100)
    expect(data.metrics.todayTokens.totalTokens).toBeGreaterThanOrEqual(1700)
    expect(data.metrics.todayTokens.cacheHitRate).toBeGreaterThan(0)
    expect(data.metrics.performance.avgTtftMs).toBe(320)

    // 3. Fleet and Alerts
    expect(data.fleet).toBeDefined()
    expect(Array.isArray(data.fleet.items)).toBe(true)
    expect(Array.isArray(data.alerts)).toBe(true)

    // 4. Hourly Trend & Top Models
    expect(Array.isArray(data.hourlyTrend)).toBe(true)
    expect(Array.isArray(data.topModels)).toBe(true)
    expect(data.topModels.length).toBeGreaterThanOrEqual(1)
    expect(data.topModels[0].model).toBe("claude-3-7-sonnet")

    // 5. Recent Traces
    expect(Array.isArray(data.recentTraces)).toBe(true)
    expect(data.recentTraces.length).toBeGreaterThanOrEqual(1)
    expect(data.recentTraces[0].requestId).toBe("req-1")
    expect(data.recentTraces[0].ttftMs).toBe(320)
  })

  test("dashboard and usage Today agree across viewer midnight, including supplementary and cache tokens", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-10-17T15:59:30Z"),
    )
    setupAdminAuth()
    try {
      for (const [
        timestamp,
        promptTokens,
        completionTokens,
        cacheReadTokens,
        cacheWriteTokens,
        requestCount,
      ] of [
        [Date.parse("2026-10-16T15:59:59.999Z"), 90, 10, 0, 0, 1],
        [Date.parse("2026-10-16T16:00:00Z"), 4, 2, 3, 1, 1],
        [Date.parse("2026-10-17T00:00:00Z"), 10, 5, 4, 1, 0],
        [Date.parse("2026-10-17T16:00:00Z"), 900, 100, 0, 0, 1],
      ]) {
        statsStore.recordUsage({
          date: statsStore.getDateString(timestamp),
          timestamp,
          accountId: "viewer-day",
          model: "gpt-5",
          promptTokens,
          completionTokens,
          cacheReadTokens,
          cacheWriteTokens,
          requestCount,
          totalTokens:
            promptTokens
            + completionTokens
            + cacheReadTokens
            + cacheWriteTokens,
          cost: 0,
        })
      }
      const api = runInNewContext(
        `${readFileSync("pages/js/api.js", "utf8")}\nAPI`,
        {
          URLSearchParams,
          Intl: {
            DateTimeFormat: () => ({
              resolvedOptions: () => ({ timeZone: "Asia/Shanghai" }),
            }),
          },
        },
      ) as {
        request: (url: string) => Promise<unknown>
        dashboard: {
          get: () => Promise<{
            metrics: {
              todayTokens: {
                totalTokens: number
                cacheReadTokens: number
                cacheWriteTokens: number
              }
            }
          }>
        }
        usage: {
          summary: () => Promise<{
            totals: { totalTokens: number; requests: number }
            period: { timeZone: string }
          }>
        }
      }
      api.request = async (url) => {
        const response = await server.fetch(
          adminRequest(`http://localhost/admin/api${url}`),
        )
        expect(response.status).toBe(200)
        return response.json()
      }
      const dashboard = await api.dashboard.get()
      const usage = await api.usage.summary()
      expect(usage.period.timeZone).toBe("Asia/Shanghai")
      expect(usage.totals).toMatchObject({ totalTokens: 30, requests: 1 })
      expect(dashboard.metrics.todayTokens).toMatchObject({
        totalTokens: 30,
        cacheReadTokens: 7,
        cacheWriteTokens: 2,
      })
    } finally {
      clock.mockRestore()
    }
  })

  test("viewer-day counts retain failures while model shares and performance use their own sample denominators", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-10-17T03:00:00Z"),
    )
    setupAdminAuth()
    try {
      const start = Date.parse("2026-10-16T16:00:00Z")
      const end = Date.parse("2026-10-17T16:00:00Z")
      // Nine A requests, but just one timing sample; B has a different
      // output size and rate. Arithmetic/request-weighted TPS is incorrect.
      for (let i = 0; i < 13; i++) {
        const timestamp =
          i === 11 ? start - 1
          : i === 12 ? end
          : start + i
        const timed = i === 0 || i === 9 || i >= 10
        const isB = i === 9
        if (i !== 10) statsStore.incrementRequests("day-account", timestamp)
        statsStore.recordUsage({
          date: statsStore.getDateString(timestamp),
          timestamp,
          accountId: "day-account",
          model: isB ? "model-b" : "model-a",
          promptTokens: 1,
          completionTokens: isB ? 1800 : 100,
          totalTokens: isB ? 1801 : 101,
          cost: 0,
          requestCount: i === 10 ? 0 : 1,
          ttftMs:
            timed ?
              isB ? 900
              : i === 0 ? 100
              : 9900
            : undefined,
          tps:
            timed ?
              isB ? 90
              : i === 0 ? 10
              : 990
            : undefined,
          streaming: !isB,
        })
      }
      statsStore.incrementRequestAndError("failed-no-usage", start + 100)
      const response = await server.fetch(
        adminRequest("http://localhost/admin/api/dashboard?tz=Asia/Shanghai"),
      )
      const data = (await response.json()) as {
        requestsToday: number
        errorsToday: number
        metrics: {
          successRate: number
          requestCountsSince: number | null
          performance: { avgTtftMs: number | null; avgTps: number | null }
        }
        topModels: Array<{ percentage: number }>
        hourlyTrend: Array<{ slotTs: number; hour: string }>
      }
      expect(data.requestsToday).toBe(11)
      expect(data.errorsToday).toBe(1)
      expect(data.metrics.successRate).toBe(90.9)
      expect(data.metrics.requestCountsSince).toBeNull()
      expect(
        data.topModels.map((row: { percentage: number }) => row.percentage),
      ).toEqual([90, 10])
      expect(data.metrics.performance).toEqual({ avgTtftMs: 500, avgTps: 63.3 })
      expect(
        data.hourlyTrend.every(
          (slot: { slotTs: number; hour: string }) =>
            slot.hour
            === new Intl.DateTimeFormat("en-GB", {
              timeZone: "Asia/Shanghai",
              hour: "2-digit",
              hourCycle: "h23",
            }).format(slot.slotTs)
              + ":00",
        ),
      ).toBe(true)

      const perfResponse = await server.fetch(
        adminRequest(
          "http://localhost/admin/api/usage/performance?range=today&tz=Asia/Shanghai",
        ),
      )
      const perf = (await perfResponse.json()) as Awaited<
        ReturnType<typeof statsStore.getPerformanceInRange>
      >
      expect(perf.summary).toMatchObject({
        requests: 10,
        streamingRequests: 9,
        ttftSamples: 2,
        tpsSamples: 2,
        avgTtftMs: 500,
      })
      // 100 output tokens / 10 tok/s = 10s; 1800 / 90 = 20s.
      // Combined throughput is 1900 / 30, not the arithmetic mean (50).
      expect(perf.summary.avgTps).toBeCloseTo(63.333333, 5)
      const view = runInNewContext(
        readFileSync("pages/js/views/performance.js", "utf8")
          + "\nperformanceView()",
        {
          ViewHelpers: {},
          usageAutoRefresh: () => ({}),
          API: { usage: { performance: async () => perf } },
        },
      )
      await view.loadPerformance()
      expect(view.globalStats).toMatchObject({
        totalRequests: 10,
        totalSamples: 2,
        avgTtft: 500,
      })
      expect(view.globalStats.avgTps).toBeCloseTo(63.333333, 5)
      view.summary = null
      await view.refreshCachedUsage()
      expect(view.globalStats.avgTps).toBeCloseTo(63.333333, 5)
    } finally {
      clock.mockRestore()
    }
  })

  test("CodeBuddy zero credits are not displayed as an account-wide HTTP 429 cooldown", async () => {
    const conn = managedConnectionFromInput({
      id: "dashboard-zero-credit",
      name: "CodeBuddy-Zero",
      provider: "codebuddy",
      credentials: { accessToken: "fixture-token" },
    })
    upsertProviderConnection(conn)
    setConnectionQuotaState(conn, "exhausted")
    conn.credentials[0].lastError = "HTTP 429"
    try {
      const response = await server.fetch(
        adminRequest("http://localhost/admin/api/dashboard"),
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as {
        alerts: {
          connectionId: string
          type: string
          message: string
          cooldownRemainingMs?: number
        }[]
      }
      const alert = data.alerts.find((item) => item.connectionId === conn.id)!
      expect(alert.type).toBe("exhausted")
      expect(alert.message).toContain("免费模型")
      expect(alert.cooldownRemainingMs).toBeUndefined()

      // Credit exhaustion does not cancel a genuine, simultaneous rate limit.
      await reportUpstreamRateLimitMs(conn.id, 60_000)
      const limited = await server.fetch(
        adminRequest("http://localhost/admin/api/dashboard"),
      )
      const limitedData = (await limited.json()) as typeof data
      const limitedAlert = limitedData.alerts.find(
        (item) => item.connectionId === conn.id,
      )!
      expect(limitedAlert.type).toBe("cooldown")
      expect(limitedAlert.cooldownRemainingMs).toBeGreaterThan(0)
      expect(limitedAlert.cooldownRemainingMs).toBeLessThanOrEqual(60_000)
    } finally {
      clearAccountRateLimitState(conn.id)
      removeProviderConnection(conn.id)
    }
  })

  test("surfaces cooldown alerts in fleet and alerts list", async () => {
    const conn: ProviderConnection = {
      id: "cooldown-conn-1",
      name: "Cooldown-Test-Conn",
      protocol: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      priority: 0,
      weight: 1,
      credentials: [
        {
          id: "cred-1",
          authMode: "bearer",
          value: "sk-test-key",
          enabled: true,
          priority: 0,
          weight: 1,
          status: "ready",
          createdAt: Date.now(),
        },
      ],
      models: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    upsertProviderConnection(conn)

    // Mark connection credential in cooldown
    markCredentialCooldown(conn.credentials[0], {
      retryAfterMs: 30_000,
      reason: "Rate limited by upstream (429)",
    })

    const res = await server.fetch(
      adminRequest("http://localhost/admin/api/dashboard"),
    )
    expect(res.status).toBe(200)

    const data = (await res.json()) as Record<string, any>
    expect(data.alerts.length).toBeGreaterThanOrEqual(1)
    const alert = data.alerts.find((a: any) => a.connectionId === conn.id)
    expect(alert).toBeDefined()
    expect(alert.type).toBe("cooldown")
    expect(alert.actionable).toBe(false)
    expect(alert.targetView).toBe("connections")
    expect(alert.isAccountManaged).toBe(false)
    expect(alert.message).toContain("Rate limited by upstream")

    // Test actionable auth_error on account-managed connection
    const authConn: ProviderConnection = {
      id: "auth-err-conn",
      name: "Codex-Account",
      protocol: "codex-native",
      baseUrl: "https://chatgpt.com/backend-api",
      enabled: true,
      priority: 0,
      weight: 1,
      credentials: [
        {
          id: "cred-2",
          authMode: "bearer",
          value: "invalid-token",
          enabled: true,
          priority: 0,
          weight: 1,
          status: "auth_error",
          lastError: "Codex token refresh failed (401)",
          createdAt: Date.now(),
        },
      ],
      models: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    upsertProviderConnection(authConn)

    const res2 = await server.fetch(
      adminRequest("http://localhost/admin/api/dashboard"),
    )
    const data2 = (await res2.json()) as Record<string, any>
    const authAlert = data2.alerts.find(
      (a: any) => a.connectionId === authConn.id,
    )
    expect(authAlert).toBeDefined()
    expect(authAlert.type).toBe("auth_error")
    expect(authAlert.actionable).toBe(true)
    expect(authAlert.isAccountManaged).toBe(true)
    expect(authAlert.targetView).toBe("accounts")
    // Actionable error should be sorted first
    expect(data2.alerts[0].actionable).toBe(true)
  })
})
