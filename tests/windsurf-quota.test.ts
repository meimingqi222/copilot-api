import { describe, expect, mock, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import {
  fetchWindsurfQuota,
  parseWindsurfQuotaPayload,
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
})
