/**
 * LobsterAI 积分拉取测试。
 *
 * 两个只读端点（与官方客户端同一套鉴权头 + keyfrom query）：
 *   GET /api/user/profile-summary → totalCreditsRemaining + creditItems[]
 *   GET /api/user/quota           → planName / freeCredits* 窗口
 * 积分是余额（无上限），余额由 chatRemaining 承载、归零判耗尽。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  getConnectionQuotaState,
} from "~/lib/provider-connections"
import type { ProviderConnection } from "~/lib/provider-connections/types"
import {
  buildLobsteraiSnapshot,
  fetchLobsteraiQuota,
} from "~/lib/quota/fetchers/lobsterai"
import { lobsteraiProviderRuntime } from "~/services/providers/lobsterai"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeConnection(): ProviderConnection {
  const now = Date.now()
  return {
    id: "lobsterai-quota",
    name: "LobsterAI",
    protocol: "lobsterai-native",
    baseUrl: "https://lobsterai-server.youdao.com",
    enabled: true,
    priority: 0,
    metadata: { provider: "lobsterai" },
    credentials: [
      {
        id: "cred",
        authMode: "bearer",
        value: "at-1",
        enabled: true,
        status: "ready",
        context: {
          refreshToken: "rt-1",
          expiresAt: now + 3_600_000,
          firstKeyfrom: "official",
          latestKeyfrom: "official",
        },
        createdAt: now,
      },
    ],
    models: [],
    createdAt: now,
  } as ProviderConnection
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const PROFILE = {
  code: 0,
  data: {
    id: 89559,
    nickname: "15559885978",
    totalCreditsRemaining: 584.83,
    creditItems: [
      {
        type: "campaign",
        creditsRemaining: 84.83,
        expiresAt: "2026-11-06T07:00:00",
      },
      {
        type: "campaign",
        creditsRemaining: 100,
        expiresAt: "2026-11-07T07:00:01",
      },
    ],
  },
}

const QUOTA = {
  code: 0,
  data: {
    planName: "免费",
    subscriptionStatus: "free",
    freeCreditsTotal: 300,
    freeCreditsUsed: 300,
    freeCreditsRemaining: 0,
    freeCreditsExpiresAt: "2026-09-24",
    dailyCreditsUsed: 15.16,
  },
}

describe("buildLobsteraiSnapshot", () => {
  test("reads the wallet balance and the free-credit window", () => {
    const snapshot = buildLobsteraiSnapshot(
      { profile: PROFILE.data, quota: QUOTA.data },
      "https://lobsterai-server.youdao.com",
    )
    expect(snapshot.provider).toBe("lobsterai")
    expect(snapshot.unlimited).toBe(false)
    // 余额是计数，不是窗口占比。
    expect(snapshot.chatRemaining).toBe(585)
    expect(snapshot.premiumInteractionsRemaining).toBeUndefined()
    const block = snapshot.details?.lobsterai as {
      plan?: string
      user?: string
      credits?: { remaining: number; expiresAt?: number }
      windows: Array<{ name: string; usedPercent: number; display: string }>
    }
    expect(block.plan).toBe("免费")
    expect(block.user).toBe("15559885978")
    expect(block.credits?.remaining).toBe(584.83)
    // 最早到期的积分项时间戳（做钱包到期提示）。
    expect(block.credits?.expiresAt).toBe(Date.parse("2026-11-06T07:00:00"))
    expect(block.windows).toHaveLength(1)
    expect(block.windows[0]?.name).toBe("Free")
    expect(block.windows[0]?.usedPercent).toBe(100)
    expect(block.windows[0]?.display).toBe("0 / 300")
  })

  test("still reports the balance when the quota endpoint is missing", () => {
    const snapshot = buildLobsteraiSnapshot(
      { profile: PROFILE.data },
      "https://lobsterai-server.youdao.com",
    )
    expect(snapshot.chatRemaining).toBe(585)
    const block = snapshot.details?.lobsterai as { windows: unknown[] }
    expect(block.windows).toEqual([])
  })

  test("falls back to the free balance and drops an empty window", () => {
    const snapshot = buildLobsteraiSnapshot(
      {
        quota: {
          planName: "标准",
          subscriptionStatus: "active",
          freeCreditsTotal: 0,
          freeCreditsRemaining: 12,
        },
      },
      "https://lobsterai-server.youdao.com",
    )
    expect(snapshot.chatRemaining).toBe(12)
    const block = snapshot.details?.lobsterai as { windows: unknown[] }
    expect(block.windows).toEqual([])
  })

  test("clamps a negative balance to zero like the official client", () => {
    const snapshot = buildLobsteraiSnapshot(
      { profile: { totalCreditsRemaining: -3 } },
      "https://lobsterai-server.youdao.com",
    )
    expect(snapshot.chatRemaining).toBe(0)
    const block = snapshot.details?.lobsterai as {
      credits?: { remaining: number }
    }
    expect(block.credits?.remaining).toBe(0)
  })
})

describe("fetchLobsteraiQuota", () => {
  test("asks both endpoints with the bearer token and keyfrom query", async () => {
    const seen: Array<{ url: string; auth: string }> = []
    globalThis.fetch = mock(
      (url: string, init: { headers: Record<string, string> }) => {
        seen.push({ url, auth: init.headers.authorization ?? "" })
        if (url.includes("/api/user/profile-summary")) {
          return Promise.resolve(jsonResponse(PROFILE))
        }
        return Promise.resolve(jsonResponse(QUOTA))
      },
    ) as unknown as typeof fetch

    const snapshot = await fetchLobsteraiQuota(makeConnection())

    expect(seen).toHaveLength(2)
    expect(seen.every((s) => s.auth === "Bearer at-1")).toBe(true)
    const summaryUrl = seen.find((s) => s.url.includes("profile-summary"))!.url
    expect(summaryUrl).toContain("firstKeyfrom=official")
    expect(summaryUrl).toContain("latestKeyfrom=official")
    expect(snapshot.chatRemaining).toBe(585)
  })

  test("survives one endpoint failing as long as the other answers", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/api/user/profile-summary")) {
        return Promise.resolve(jsonResponse({ message: "boom" }, 500))
      }
      return Promise.resolve(jsonResponse(QUOTA))
    }) as unknown as typeof fetch

    const snapshot = await fetchLobsteraiQuota(makeConnection())
    // profile 缺失 → 退回免费额度余额。
    expect(snapshot.chatRemaining).toBe(0)
    const block = snapshot.details?.lobsterai as { plan?: string }
    expect(block.plan).toBe("免费")
  })

  test("rejects a credential the endpoint refuses", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ message: "expired" }, 401)),
    ) as unknown as typeof fetch

    await expect(fetchLobsteraiQuota(makeConnection())).rejects.toThrow(
      /rejected the credential/,
    )
  })

  test("requires a LobsterAI connection", async () => {
    const connection = makeConnection()
    connection.metadata = { provider: "copilot" }
    await expect(fetchLobsteraiQuota(connection)).rejects.toThrow(
      /requires a LobsterAI connection/,
    )
  })
})

describe("lobsteraiProviderRuntime.refreshQuota", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
  })
  afterEach(() => {
    __resetProviderConnectionsForTest()
  })

  async function makeStateConnection(): Promise<ProviderConnection> {
    const connection = await createConnection({
      id: "lobsterai-runtime",
      name: "LobsterAI",
      protocol: "lobsterai-native",
      baseUrl: "https://lobsterai-server.youdao.com",
      credentials: [{ id: "cred", value: "at-1", authMode: "bearer" }],
    })
    connection.metadata = { provider: "lobsterai" }
    return connection
  }

  test("persists the snapshot so the account carries quota state", async () => {
    const connection = await makeStateConnection()
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/api/user/profile-summary")) {
        return Promise.resolve(jsonResponse(PROFILE))
      }
      return Promise.resolve(jsonResponse(QUOTA))
    }) as unknown as typeof fetch

    const snapshot = await lobsteraiProviderRuntime.refreshQuota?.(
      connection,
      new AbortController().signal,
    )

    expect(snapshot?.chatRemaining).toBe(585)
    // 快照要落到 credential.quota：只把 snapshot 返回出去的话，管理台读不到
    // 配额，路由也不会因积分归零而摘掉这个账号。
    expect(connection.credentials[0]?.quota).toBe(snapshot)
    expect(getConnectionQuotaState(connection)).toBe("available")
  })

  test("marks the connection exhausted once the credits run out", async () => {
    const connection = await makeStateConnection()
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/api/user/profile-summary")) {
        return Promise.resolve(
          jsonResponse({
            code: 0,
            data: { nickname: "u", totalCreditsRemaining: 0, creditItems: [] },
          }),
        )
      }
      return Promise.resolve(jsonResponse(QUOTA))
    }) as unknown as typeof fetch

    await lobsteraiProviderRuntime.refreshQuota?.(
      connection,
      new AbortController().signal,
    )

    expect(connection.credentials[0]?.quota?.chatRemaining).toBe(0)
    expect(getConnectionQuotaState(connection)).toBe("exhausted")
  })
})
