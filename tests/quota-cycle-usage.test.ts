import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { OAuthAccount } from "~/lib/accounts"

import { buildCodexQuotaWindows } from "~/lib/quota/codex"
import {
  attachCycleUsage,
  enrichQuotaDetails,
  enrichQuotaInfoForResponse,
  resolveAntigravityQuotaWindows,
  resolveClaudeQuotaWindows,
  resolveCodexQuotaWindows,
  resolveKimiQuotaWindows,
  supportsCycleUsage,
} from "~/lib/quota/cycles"
import { parseCodexUsagePayload } from "~/lib/quota/parsers"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

import {
  adminRequest,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"

const originalAccounts = state.accounts
const originalActiveAccountIndex = state.activeAccountIndex

const FIVE_HOUR_MS = 5 * 3_600_000
const SEVEN_DAY_MS = 7 * 86_400_000

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  state.accounts = []
  state.activeAccountIndex = 0
  clearAdminPasswordConfig()
  setupAdminAuth()
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  state.accounts = originalAccounts
  state.activeAccountIndex = originalActiveAccountIndex
  clearAdminAuth()
  clearAdminPasswordConfig()
})

describe("quota cycle window resolution", () => {
  test("resolveClaudeQuotaWindows derives 5-hour and 7-day boundaries", () => {
    const fiveHourEnd = new Date("2026-06-24T12:00:00.000Z").getTime()
    const sevenDayEnd = new Date("2026-07-01T00:00:00.000Z").getTime()
    const windows = resolveClaudeQuotaWindows({
      five_hour: {
        utilization: 0.25,
        resets_at: new Date(fiveHourEnd).toISOString(),
      },
      seven_day: {
        utilization: 0.5,
        resets_at: new Date(sevenDayEnd).toISOString(),
      },
    })

    expect(windows).toHaveLength(2)
    expect(windows[0]?.id).toBe("five_hour")
    expect(windows[0]?.windowEndMs).toBe(fiveHourEnd)
    expect(windows[0]?.windowStartMs).toBe(fiveHourEnd - FIVE_HOUR_MS)
    expect(windows[1]?.id).toBe("seven_day")
    expect(windows[1]?.windowEndMs).toBe(sevenDayEnd)
    expect(windows[1]?.windowStartMs).toBe(sevenDayEnd - SEVEN_DAY_MS)
  })

  test("resolveCodexQuotaWindows includes window boundaries from reset_at", () => {
    const resetAtSeconds = 1_751_300_000
    const payload = parseCodexUsagePayload({
      rate_limit: {
        primary_window: {
          used_percent: 40,
          limit_window_seconds: 18_000,
          reset_at: resetAtSeconds,
        },
        secondary_window: {
          used_percent: 10,
          limit_window_seconds: 604_800,
          reset_at: resetAtSeconds + 86_400,
        },
      },
    })
    if (!payload) {
      throw new Error("expected Codex usage payload")
    }

    const windows = resolveCodexQuotaWindows(
      payload as unknown as Record<string, unknown>,
    )
    expect(windows.length).toBeGreaterThanOrEqual(2)
    expect(windows[0]?.windowEndMs).toBe(resetAtSeconds * 1000)
    expect(windows[0]?.windowStartMs).toBe(
      resetAtSeconds * 1000 - 18_000 * 1000,
    )
  })

  test("resolveAntigravityQuotaWindows derives bucket cycle boundaries", () => {
    const resetTime = "2026-06-24T18:00:00.000Z"
    const windowEndMs = new Date(resetTime).getTime()
    const windows = resolveAntigravityQuotaWindows({
      groups: [
        {
          displayName: "Pro",
          buckets: [
            {
              bucketId: "five_hour_limit",
              displayName: "5h",
              window: "5h",
              remaining_fraction: 0.6,
              resetTime,
            },
          ],
        },
      ],
    })

    expect(windows).toHaveLength(1)
    expect(windows[0]?.windowEndMs).toBe(windowEndMs)
    expect(windows[0]?.windowStartMs).toBe(windowEndMs - FIVE_HOUR_MS)
  })

  test("resolveKimiQuotaWindows derives limit cycle boundaries", () => {
    const resetAt = "2026-06-25T00:00:00.000Z"
    const windowEndMs = new Date(resetAt).getTime()
    const windows = resolveKimiQuotaWindows({
      limits: [
        {
          title: "Daily",
          detail: {
            remaining: 10,
            limit: 100,
            duration: 24,
            timeUnit: "HOURS",
            reset_at: resetAt,
          },
        },
      ],
    })

    expect(windows).toHaveLength(1)
    expect(windows[0]?.id).toBe("limit-0")
    expect(windows[0]?.windowEndMs).toBe(windowEndMs)
    expect(windows[0]?.windowStartMs).toBe(
      windowEndMs - (24 * FIVE_HOUR_MS) / 5,
    )
  })
})

describe("quota cycle usage aggregation", () => {
  test("getUsageByTimestampRange sums cost and tokens inside the window", () => {
    const windowStart = new Date("2026-06-24T08:00:00.000Z").getTime()
    const windowEnd = new Date("2026-06-24T13:00:00.000Z").getTime()
    const inside = windowStart + 60_000
    const outside = windowStart - 60_000

    statsStore.recordUsage({
      date: "2026-06-24",
      accountId: "acct-cycle",
      model: "claude-sonnet-4.6",
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
      cost: 1.5,
      timestamp: inside,
    })
    statsStore.recordUsage({
      date: "2026-06-24",
      accountId: "acct-cycle",
      model: "gpt-5",
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      cost: 0.4,
      timestamp: inside + 1,
    })
    statsStore.recordUsage({
      date: "2026-06-24",
      accountId: "acct-cycle",
      model: "gpt-5",
      promptTokens: 900,
      completionTokens: 100,
      totalTokens: 1000,
      cost: 9.9,
      timestamp: outside,
    })

    const summary = statsStore.getUsageByTimestampRange(
      "acct-cycle",
      windowStart,
      windowEnd,
    )
    expect(summary.requests).toBe(2)
    expect(summary.totalTokens).toBe(1800)
    expect(summary.cost).toBeCloseTo(1.9, 10)
    const claudeModel = summary.models["claude-sonnet-4.6"]
    const gptModel = summary.models["gpt-5"]
    expect(claudeModel).toBeDefined()
    expect(gptModel).toBeDefined()
    expect(claudeModel.cost).toBeCloseTo(1.5, 10)
    expect(gptModel.cost).toBeCloseTo(0.4, 10)
  })

  test("attachCycleUsage adds per-window cycleUsage summaries", () => {
    const windowStart = new Date("2026-06-24T08:00:00.000Z").getTime()
    const windowEnd = new Date("2026-06-24T13:00:00.000Z").getTime()
    statsStore.recordUsage({
      date: "2026-06-24",
      accountId: "acct-attach",
      model: "claude-sonnet-4.6",
      promptTokens: 300,
      completionTokens: 100,
      totalTokens: 400,
      cost: 0.25,
      timestamp: windowStart + 30_000,
    })

    const enriched = attachCycleUsage("acct-attach", [
      {
        id: "five_hour",
        labelKey: "quota.oauth.claude.fiveHour",
        windowStartMs: windowStart,
        windowEndMs: windowEnd,
      },
    ])

    expect(enriched[0]?.cycleUsage?.requests).toBe(1)
    expect(enriched[0]?.cycleUsage?.cost).toBeCloseTo(0.25, 10)
  })

  test("supportsCycleUsage excludes xAI", () => {
    expect(supportsCycleUsage("codex")).toBe(true)
    expect(supportsCycleUsage("claude")).toBe(true)
    expect(supportsCycleUsage("antigravity")).toBe(true)
    expect(supportsCycleUsage("kimi")).toBe(true)
    expect(supportsCycleUsage("xai")).toBe(false)
    expect(supportsCycleUsage("copilot")).toBe(false)
  })
})

describe("GET /admin/api/quota cycle usage", () => {
  test("returns cycleUsage for Codex accounts and omits it for xAI", async () => {
    const windowEndMs = Date.now() + 3_600_000
    const resetAtSeconds = Math.floor(windowEndMs / 1000)
    const payload = parseCodexUsagePayload({
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_at: resetAtSeconds,
        },
        secondary_window: {
          used_percent: 30,
          limit_window_seconds: 604_800,
          reset_at: resetAtSeconds + 3600,
        },
      },
    })
    if (!payload) {
      throw new Error("expected Codex usage payload")
    }

    const codexWindows = buildCodexQuotaWindows(payload)
    const codexDetails = enrichQuotaDetails("codex", {
      ...(payload as unknown as Record<string, unknown>),
      _codexMeta: { windows: codexWindows },
    })

    const codexAccount: OAuthAccount = {
      id: "acct-codex-cycle",
      label: "Codex Cycle",
      provider: "codex",
      enabled: true,
      priority: 0,
      quotaState: "available",
      createdAt: Date.now(),
      credentials: { accessToken: "codex-token" },
      quotaInfo: {
        fetchedAt: Date.now(),
        unlimited: false,
        premiumInteractionsRemaining: 80,
        provider: "codex",
        details: codexDetails,
      },
    }

    const xaiAccount: OAuthAccount = {
      id: "acct-xai-cycle",
      label: "xAI Cycle",
      provider: "xai",
      enabled: true,
      priority: 1,
      quotaState: "available",
      createdAt: Date.now(),
      credentials: { accessToken: "xai-token" },
      quotaInfo: {
        fetchedAt: Date.now(),
        unlimited: false,
        provider: "xai",
        details: {
          config: {
            monthly_limit: 10_000,
            used: 2_500,
          },
        },
      },
    }

    state.accounts = [codexAccount, xaiAccount]

    if (codexWindows.length === 0) {
      throw new Error("expected Codex window boundaries")
    }
    const firstWindow = codexWindows[0]
    if (
      firstWindow.windowStartMs === null
      || firstWindow.windowEndMs === null
    ) {
      throw new Error("expected Codex window boundaries")
    }

    statsStore.recordUsage({
      date: "2026-06-24",
      accountId: codexAccount.id,
      model: "gpt-5",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cost: 0.12,
      timestamp: firstWindow.windowStartMs + 1000,
    })

    const response = await server.fetch(
      adminRequest("http://localhost/admin/api/quota"),
    )
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      accounts: Array<{
        id: string
        provider: string
        quotaInfo?: {
          details?: {
            _quotaWindows?: Array<{
              cycleUsage?: { cost: number }
            }>
          }
        }
      }>
    }

    const codex = body.accounts.find((item) => item.id === codexAccount.id)
    const xai = body.accounts.find((item) => item.id === xaiAccount.id)
    expect(
      codex?.quotaInfo?.details?._quotaWindows?.[0]?.cycleUsage?.cost,
    ).toBeCloseTo(0.12, 10)
    expect(xai?.quotaInfo?.details?._quotaWindows).toBeUndefined()
  })

  test("enrichQuotaInfoForResponse leaves unsupported providers unchanged", () => {
    const quotaInfo = {
      details: {
        config: { used: 100, monthly_limit: 1000 },
      },
    }
    const enriched = enrichQuotaInfoForResponse("acct-xai", "xai", quotaInfo)
    expect(enriched).toBe(quotaInfo)
    expect(enriched?.details?._quotaWindows).toBeUndefined()
  })
})
