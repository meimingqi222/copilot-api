/**
 * Qoder 配额拉取测试。
 *
 * 端点 `GET https://openapi.qoder.sh/sash/api/v2/me/usage`，用**设备 token**
 * 直接 Bearer（不是 chat 的 job token）。401/403 时惰性轮换设备 token 重试一次；
 * 设备 token 只服务账号页，轮换失败绝不能把连接标成 auth_error。
 */
import { afterEach, describe, expect, mock, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections/types"
import { parseQoderQuota } from "~/lib/quota/fetchers/qoder"
import { fetchQoderQuota } from "~/lib/quota/fetchers/qoder"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeConnection(): ProviderConnection {
  const now = Date.now()
  return {
    id: "qoder-quota",
    name: "Qoder",
    protocol: "qoder-native",
    baseUrl: "https://api3.qoder.sh",
    enabled: true,
    priority: 0,
    credentials: [
      {
        id: "cred",
        authMode: "bearer",
        value: "jt-1",
        enabled: true,
        status: "ready",
        context: {
          deviceToken: "dt-1",
          deviceRefreshToken: "drt-1",
          uid: "uid-1",
          machineId: "machine-1",
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

const USAGE = {
  displayMode: "qoder",
  qoderUsage: {
    userType: "Pro",
    userQuota: { total: 2000, used: 500, name: "Credits", unit: "credits" },
    addOnQuota: { cap: 100, remaining: 100, name: "Top-up" },
    dedicatedResourcePackages: [
      { total: 50, used: 60, name: "Team pack", unit: "credits" },
    ],
  },
}

describe("parseQoderQuota", () => {
  test("reads every credit window and clamps the used percentage", () => {
    const parsed = parseQoderQuota(USAGE)
    expect(parsed?.displayMode).toBe("qoder")
    expect(parsed?.plan).toBe("Pro")
    const windows = parsed!.windows
    expect(windows.map((w) => w.name)).toEqual([
      "Credits",
      "Top-up",
      "Team pack",
    ])
    expect(windows[0]).toMatchObject({
      used: 500,
      total: 2000,
      unit: "credits",
    })
    expect(windows[0]?.usedPercent).toBe(25)
    // cap + remaining 形态：used = cap - remaining = 0。
    expect(windows[1]).toMatchObject({ used: 0, total: 100, unit: "credits" })
    expect(windows[1]?.usedPercent).toBe(0)
    // 已用超过总量时夹到 100，不产生负剩余。
    expect(windows[2]?.usedPercent).toBe(100)
  })

  test("drops windows without a usable total", () => {
    const parsed = parseQoderQuota({
      displayMode: "qoder",
      qoderUsage: {
        userQuota: { total: 0, used: 0 },
        addOnQuota: { total: 100 },
        orgResourcePackage: { total: 10, used: 2 },
      },
    })
    expect(parsed?.windows.map((w) => w.name)).toEqual(["Shared credits"])
  })

  test("accepts the snake_case spelling and reports enterprise as unlimited", () => {
    const parsed = parseQoderQuota({
      displayMode: "qoder",
      qoderUsage: { user_quota: { total: 10, used: 10 } },
    })
    expect(parsed?.windows).toHaveLength(1)
    expect(parsed?.windows[0]?.usedPercent).toBe(100)

    expect(parseQoderQuota({ displayMode: "enterprise" })).toEqual({
      displayMode: "enterprise",
      windows: [],
    })
    expect(parseQoderQuota({ displayMode: "unknown" })).toBeUndefined()
    expect(parseQoderQuota(null)).toBeUndefined()
  })
})

describe("fetchQoderQuota", () => {
  test("asks the usage endpoint with the device token and builds a snapshot", async () => {
    const seen: Array<{ url: string; auth: string }> = []
    globalThis.fetch = mock(
      (url: string, init: { headers: Record<string, string> }) => {
        seen.push({ url, auth: init.headers.Authorization ?? "" })
        return Promise.resolve(jsonResponse(USAGE))
      },
    ) as unknown as typeof fetch

    const snapshot = await fetchQoderQuota(makeConnection())

    expect(seen[0]?.url).toBe("https://openapi.qoder.sh/sash/api/v2/me/usage")
    // 账号页用设备 token，而不是 chat 的 job token。
    expect(seen[0]?.auth).toBe("Bearer dt-1")
    expect(snapshot.provider).toBe("qoder")
    expect(snapshot.unlimited).toBe(false)
    // 头号百分比取最紧的窗口：Team pack 已用 100% ⇒ 剩余 0%。
    expect(snapshot.premiumInteractionsRemaining).toBe(0)
    expect(snapshot.premiumInteractionsTotal).toBe(100)
    // 计数用第一个窗口（userQuota）。
    expect(snapshot.chatRemaining).toBe(1500)
    expect(snapshot.chatTotal).toBe(2000)
    const details = snapshot.details?.qoder as
      | { displayMode?: string; plan?: string }
      | undefined
    expect(details?.displayMode).toBe("qoder")
    expect(details?.plan).toBe("Pro")
  })

  test("refreshes the device token once on 401 and writes it back", async () => {
    const connection = makeConnection()
    const urls: Array<string> = []
    let usageCalls = 0
    globalThis.fetch = mock((url: string) => {
      urls.push(String(url))
      if (String(url).includes("/api/v1/deviceToken/refresh")) {
        return Promise.resolve(
          jsonResponse({ token: "dt-2", refresh_token: "drt-2" }),
        )
      }
      usageCalls += 1
      if (usageCalls === 1) {
        return Promise.resolve(jsonResponse({ message: "expired" }, 401))
      }
      return Promise.resolve(jsonResponse(USAGE))
    }) as unknown as typeof fetch

    const snapshot = await fetchQoderQuota(connection)

    expect(urls[1]).toBe("https://openapi.qoder.sh/api/v1/deviceToken/refresh")
    expect(connection.credentials[0]?.context?.deviceToken).toBe("dt-2")
    expect(connection.credentials[0]?.context?.deviceRefreshToken).toBe("drt-2")
    expect(snapshot.premiumInteractionsRemaining).toBe(0)
  })

  test("reports an unavailable usage page without touching the chat credential", async () => {
    const connection = makeConnection()
    globalThis.fetch = mock((url: string) => {
      if (String(url).includes("/deviceToken/refresh")) {
        return Promise.resolve(jsonResponse({ message: "refused" }, 401))
      }
      return Promise.resolve(jsonResponse({ message: "expired" }, 401))
    }) as unknown as typeof fetch

    await expect(fetchQoderQuota(connection)).rejects.toThrow(
      /chat still works/,
    )
    // 设备页失败不能把 chat 的凭证标成错误。
    expect(connection.credentials[0]?.status).toBe("ready")
    expect(connection.credentials[0]?.value).toBe("jt-1")
  })

  test("explains when the saved sign-in has no device token", async () => {
    const connection = makeConnection()
    connection.credentials[0]!.context = {}
    await expect(fetchQoderQuota(connection)).rejects.toThrow(/device token/)
  })

  test("surfaces an unknown display mode instead of faking quota", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ displayMode: "something-else" })),
    ) as unknown as typeof fetch

    await expect(fetchQoderQuota(makeConnection())).rejects.toThrow(
      /unknown display mode/,
    )
  })
})
