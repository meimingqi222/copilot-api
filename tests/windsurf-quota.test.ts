import { describe, expect, mock, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  getConnectionQuotaState,
} from "~/lib/provider-connections"
import {
  fetchWindsurfQuota,
  parseWindsurfQuotaPayload,
  refreshWindsurfQuota,
} from "~/lib/quota/fetchers/windsurf"

function encodeVarint(value: number): Array<number> {
  const out: Array<number> = []
  let remaining = Math.trunc(value)
  while (remaining >= 0x80) {
    out.push((remaining & 0x7f) | 0x80)
    remaining = Math.trunc(remaining / 128)
  }
  out.push(remaining)
  return out
}

function encodeField(
  field: number,
  wire: number,
  body: Array<number>,
): Array<number> {
  return [
    ...encodeVarint((field << 3) | wire),
    ...encodeVarint(body.length),
    ...body,
  ]
}

function encodeString(field: number, value: string): Array<number> {
  return encodeField(field, 2, Array.from(new TextEncoder().encode(value)))
}

function encodeMessage(field: number, body: Array<number>): Array<number> {
  return encodeField(field, 2, body)
}

function encodeVarintField(field: number, value: number): Array<number> {
  return [...encodeVarint(Math.trunc(field * 8)), ...encodeVarint(value)]
}

/** 构造 GetUserStatus 响应：F1(UserStatus) → F13(QuotaInfo)。 */
function buildQuotaPayload(opts: {
  dailyRemaining?: number
  weeklyRemaining?: number
  overageMicros?: number
  dailyReset?: number
  weeklyReset?: number
  plan?: string
}): Uint8Array {
  const quota: Array<number> = []
  if (opts.plan) {
    quota.push(...encodeMessage(1, encodeString(2, opts.plan)))
  }
  if (opts.dailyRemaining !== undefined) {
    quota.push(...encodeVarintField(14, opts.dailyRemaining))
  }
  if (opts.weeklyRemaining !== undefined) {
    quota.push(...encodeVarintField(15, opts.weeklyRemaining))
  }
  if (opts.overageMicros !== undefined) {
    quota.push(...encodeVarintField(16, opts.overageMicros))
  }
  if (opts.dailyReset !== undefined) {
    quota.push(...encodeVarintField(17, opts.dailyReset))
  }
  if (opts.weeklyReset !== undefined) {
    quota.push(...encodeVarintField(18, opts.weeklyReset))
  }
  return new Uint8Array(encodeMessage(1, encodeMessage(13, quota)))
}

describe("parseWindsurfQuotaPayload", () => {
  test("parses remaining percentages into used percentages", () => {
    const payload = buildQuotaPayload({
      dailyRemaining: 72,
      weeklyRemaining: 68,
      dailyReset: 1_700_000_000,
      weeklyReset: 1_700_060_000,
      overageMicros: 193_449_258,
      plan: "Pro",
    })
    const parsed = parseWindsurfQuotaPayload(payload)
    expect(parsed.dailyUsedPercent).toBe(28)
    expect(parsed.weeklyUsedPercent).toBe(32)
    expect(parsed.dailyResetAt).toBe(1_700_000_000)
    expect(parsed.weeklyResetAt).toBe(1_700_060_000)
    expect(parsed.overageCredits).toBeCloseTo(193.449258, 6)
    expect(parsed.planName).toBe("pro")
  })

  test("throws when quota fields are missing", () => {
    expect(() => parseWindsurfQuotaPayload(new Uint8Array([]))).toThrow()
  })
})

describe("fetchWindsurfQuota", () => {
  test("fetches GetUserStatus and builds a snapshot", async () => {
    __resetProviderConnectionsForTest()
    const connection = await createConnection({
      name: "windsurf-quota-test",
      protocol: "windsurf-native",
      baseUrl: "https://server.codeium.com",
      credentials: [{ value: "devin-session-token$jwt", authMode: "bearer" }],
      models: [],
    })

    const payload = buildQuotaPayload({
      dailyRemaining: 80,
      weeklyRemaining: 60,
    })
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(payload as unknown as Uint8Array<ArrayBuffer>, {
          status: 200,
        }),
      ),
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const snapshot = await fetchWindsurfQuota(connection)
      expect(snapshot.provider).toBe("windsurf")
      // weekly 剩余 60 → 剩余 60（premiumInteractionsRemaining 取剩余值）
      expect(snapshot.premiumInteractionsRemaining).toBe(60)
      expect(snapshot.unlimited).toBe(false)
      expect(
        (snapshot.details as { weeklyUsedPercent?: number })?.weeklyUsedPercent,
      ).toBe(40)
      const firstCall = fetchMock.mock.calls[0] as unknown as
        | [unknown, { headers?: Record<string, string> }]
        | undefined
      const calledUrl = String(firstCall?.[0] ?? "")
      expect(calledUrl).toContain("GetUserStatus")
      const authHeader = firstCall?.[1]?.headers?.authorization
      expect(authHeader).toContain(
        "devin-session-token$jwt-devin-session-token$jwt",
      )
    } finally {
      globalThis.fetch = originalFetch
      __resetProviderConnectionsForTest()
    }
  })

  test("rejects non-windsurf connections", async () => {
    __resetProviderConnectionsForTest()
    const connection = await createConnection({
      name: "codex-quota-test",
      protocol: "codex-native",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      credentials: [{ value: "x", authMode: "bearer" }],
      models: [],
    })
    try {
      await expect(fetchWindsurfQuota(connection)).rejects.toThrow()
    } finally {
      __resetProviderConnectionsForTest()
    }
  })

  /**
   * 双窗口判定（回归测试）。
   *
   * 日额度是周额度的子窗口：旧实现只要 weekly 有值就忽略 daily，于是"日额度打满、周
   * 还有余"会被判成可用，继续派请求然后被上游拒。现在剩余取两窗口较小者，耗尽时按
   * 用尽窗口的重置时刻设置恢复时间。
   */
  describe("windsurf 双窗口判定", () => {
    async function withStubbedQuota<T>(
      payload: Uint8Array,
      run: (
        connection: Awaited<ReturnType<typeof createConnection>>,
      ) => Promise<T>,
    ): Promise<T> {
      __resetProviderConnectionsForTest()
      const connection = await createConnection({
        name: "windsurf-window-test",
        protocol: "windsurf-native",
        baseUrl: "https://server.codeium.com",
        credentials: [{ value: "devin-session-token$jwt", authMode: "bearer" }],
        models: [],
      })
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(payload as unknown as Uint8Array<ArrayBuffer>, {
            status: 200,
          }),
        ),
      ) as unknown as typeof fetch
      try {
        return await run(connection)
      } finally {
        globalThis.fetch = originalFetch
        __resetProviderConnectionsForTest()
      }
    }

    test("日额度用尽、周还有余 → 判为耗尽，恢复时间对齐日窗口重置", async () => {
      const resetInSeconds = Math.floor(Date.now() / 1000) + 3600
      const payload = buildQuotaPayload({
        dailyRemaining: 0,
        weeklyRemaining: 55,
        dailyReset: resetInSeconds,
        weeklyReset: resetInSeconds + 3 * 24 * 3600,
      })

      await withStubbedQuota(payload, async (connection) => {
        const snapshot = await refreshWindsurfQuota(connection)
        // 剩余取更紧张的窗口：日 0%
        expect(snapshot.premiumInteractionsRemaining).toBe(0)
        expect(getConnectionQuotaState(connection)).toBe("exhausted")
        const cooldownUntil = connection.credentials[0].cooldownUntil ?? 0
        expect(cooldownUntil).toBeGreaterThan(Date.now())
        // 对齐日窗口重置（而不是 24h 兜底）
        expect(cooldownUntil).toBeLessThanOrEqual(resetInSeconds * 1000)
      })
    })

    test("日额度未用、周用了一半 → 判为可用（线上实测形态）", async () => {
      const payload = buildQuotaPayload({
        dailyRemaining: 100,
        weeklyRemaining: 50,
      })

      await withStubbedQuota(payload, async (connection) => {
        const snapshot = await refreshWindsurfQuota(connection)
        expect(snapshot.premiumInteractionsRemaining).toBe(50)
        expect(getConnectionQuotaState(connection)).toBe("available")
        expect(connection.credentials[0].status).toBe("ready")
      })
    })

    test("both exhausted windows stay locked until the later reset", async () => {
      const dailyReset = Math.floor(Date.now() / 1000) + 3600
      const weeklyReset = dailyReset + 4 * 3600
      const payload = buildQuotaPayload({
        dailyRemaining: 0,
        weeklyRemaining: 0,
        dailyReset,
        weeklyReset,
      })
      await withStubbedQuota(payload, async (connection) => {
        await refreshWindsurfQuota(connection)
        expect(connection.credentials[0].cooldownUntil).toBeGreaterThanOrEqual(
          weeklyReset * 1000 - 1000,
        )
      })
    })

    test("周额度用尽同样判为耗尽", async () => {
      const payload = buildQuotaPayload({
        dailyRemaining: 100,
        weeklyRemaining: 0,
      })

      await withStubbedQuota(payload, async (connection) => {
        await refreshWindsurfQuota(connection)
        expect(getConnectionQuotaState(connection)).toBe("exhausted")
      })
    })

    test("重置时刻异常（已过期/过远）时夹在 1min~24h 之间", async () => {
      const payload = buildQuotaPayload({
        dailyRemaining: 0,
        dailyReset: Math.floor(Date.now() / 1000) - 600,
        weeklyRemaining: 0,
        weeklyReset: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      })

      await withStubbedQuota(payload, async (connection) => {
        await refreshWindsurfQuota(connection)
        const cooldownUntil = connection.credentials[0].cooldownUntil ?? 0
        const waitMs = cooldownUntil - Date.now()
        expect(waitMs).toBeGreaterThanOrEqual(59_000)
        expect(waitMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1_000)
      })
    })
  })
})
