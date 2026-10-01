import { beforeEach, describe, expect, test } from "bun:test"
import type { ProviderConnection } from "~/lib/provider-connections"
import {
  markCredentialCooldown,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { publishTrace } from "~/lib/trace-bus"
import { server } from "~/server"

import { adminRequest, setupAdminAuth } from "./admin-test-utils"

describe("Admin Dashboard API", () => {
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
