import { afterEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import {
  applyCodebuddyOAuthBundle,
  codebuddyRealmConfig,
  isCodebuddyOAuthProviderId,
  pollCodebuddyDeviceAuthorization,
  startCodebuddyDeviceFlow,
} from "~/services/oauth/codebuddy"
import { getOAuthStrategy } from "~/services/oauth/provider-strategies"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(handler: (url: string) => Response): void {
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(handler(String(input)))) as unknown as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function emptyConnection(name: string): ProviderConnection {
  const now = Date.now()
  return {
    id: "conn-1",
    name,
    protocol: "codebuddy-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred-1",
        authMode: "header",
        value: "",
        enabled: true,
        status: "ready",
        context: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
    models: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  }
}

describe("codebuddy oauth realm config", () => {
  test("cn realm points at copilot.tencent.com", () => {
    expect(codebuddyRealmConfig("codebuddy-cn")).toEqual({
      base: "https://copilot.tencent.com",
      origin: "https://www.codebuddy.cn",
      domain: "www.codebuddy.cn",
    })
  })

  test("intl realm points at www.workbuddy.ai", () => {
    expect(codebuddyRealmConfig("codebuddy")).toEqual({
      base: "https://www.workbuddy.ai",
      origin: "https://www.workbuddy.ai",
      domain: "www.workbuddy.ai",
    })
  })

  test("provider id guard", () => {
    expect(isCodebuddyOAuthProviderId("codebuddy")).toBe(true)
    expect(isCodebuddyOAuthProviderId("codebuddy-cn")).toBe(true)
    expect(isCodebuddyOAuthProviderId("claude")).toBe(false)
  })

  test("strategies registered as device flow", () => {
    expect(getOAuthStrategy("codebuddy")?.flowType).toBe("device")
    expect(getOAuthStrategy("codebuddy-cn")?.flowType).toBe("device")
  })
})

describe("startCodebuddyDeviceFlow", () => {
  test("posts to realm state endpoint and returns state+authUrl", async () => {
    const seen: Array<string> = []
    mockFetch((url) => {
      seen.push(url)
      return jsonResponse({
        code: 0,
        data: { state: "state-1", authUrl: "https://example.com/login" },
      })
    })
    const result = await startCodebuddyDeviceFlow("codebuddy-cn")
    expect(result).toEqual({
      state: "state-1",
      authUrl: "https://example.com/login",
    })
    expect(seen).toEqual([
      "https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI",
    ])
  })

  test("intl realm uses www.workbuddy.ai", async () => {
    const seen: Array<string> = []
    mockFetch((url) => {
      seen.push(url)
      return jsonResponse({
        code: 0,
        data: { state: "s", authUrl: "https://example.com/l" },
      })
    })
    await startCodebuddyDeviceFlow("codebuddy")
    expect(seen).toEqual([
      "https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI",
    ])
  })

  test("empty state/authUrl throws", async () => {
    mockFetch(() => jsonResponse({ code: 0, data: {} }))
    await expect(startCodebuddyDeviceFlow("codebuddy-cn")).rejects.toThrow(
      /empty state or authUrl/,
    )
  })

  test("business error code throws", async () => {
    mockFetch(() => jsonResponse({ code: 10001, msg: "busy" }))
    await expect(startCodebuddyDeviceFlow("codebuddy-cn")).rejects.toThrow(
      /code=10001/,
    )
  })
})

describe("pollCodebuddyDeviceAuthorization", () => {
  test("pending then success returns full bundle", async () => {
    const seen: Array<string> = []
    let tokenCalls = 0
    mockFetch((url) => {
      seen.push(url)
      if (url.includes("/v2/plugin/auth/token")) {
        tokenCalls += 1
        if (tokenCalls === 1) {
          return jsonResponse({ code: 20001, msg: "login ing" })
        }
        return jsonResponse({
          code: 0,
          data: {
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresIn: 3600,
            domain: "www.codebuddy.cn",
          },
        })
      }
      if (url.includes("/v2/plugin/login/account")) {
        return jsonResponse({
          code: 0,
          data: { uid: "u1", enterpriseId: "e1", nickname: "nick" },
        })
      }
      // CN daily checkin (best-effort)
      return jsonResponse({ code: 0, data: {} })
    })
    const bundle = await pollCodebuddyDeviceAuthorization(
      "codebuddy-cn",
      "state-1",
      { intervalMs: 5, timeoutMs: 2000 },
    )
    expect(bundle.accessToken).toBe("access-1")
    expect(bundle.refreshToken).toBe("refresh-1")
    expect(bundle.uid).toBe("u1")
    expect(bundle.enterpriseId).toBe("e1")
    expect(bundle.nickname).toBe("nick")
    expect(bundle.domain).toBe("www.codebuddy.cn")
    expect(bundle.expiresAt).toBeGreaterThan(Date.now())
    expect(tokenCalls).toBe(2)
    expect(seen.some((u) => u.includes("daily-checkin"))).toBe(true)
  })

  test("account endpoint failure does not block login", async () => {
    mockFetch((url) => {
      if (url.includes("/v2/plugin/auth/token")) {
        return jsonResponse({
          code: 0,
          data: { accessToken: "access-1", expiresIn: 60 },
        })
      }
      return jsonResponse({ code: 50001, msg: "boom" }, 500)
    })
    const bundle = await pollCodebuddyDeviceAuthorization(
      "codebuddy",
      "state-1",
      { intervalMs: 5, timeoutMs: 2000 },
    )
    expect(bundle.accessToken).toBe("access-1")
    expect(bundle.uid).toBeUndefined()
  })

  test("timeout throws", async () => {
    mockFetch(() => jsonResponse({ code: 20001, msg: "login ing" }))
    await expect(
      pollCodebuddyDeviceAuthorization("codebuddy-cn", "state-1", {
        intervalMs: 5,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/)
  })
})

describe("applyCodebuddyOAuthBundle", () => {
  test("persists realm baseUrl/headers/provider and renames auto label", () => {
    const conn = emptyConnection("codebuddy-cn-1")
    applyCodebuddyOAuthBundle(conn, "codebuddy-cn", {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3600_000,
      domain: "www.codebuddy.cn",
      uid: "u1",
      enterpriseId: "e1",
      nickname: "nick",
    })
    expect(conn.credentials[0]?.value).toBe("access-1")
    expect(conn.baseUrl).toBe("https://copilot.tencent.com/v2")
    expect(conn.headers?.["X-Domain"]).toBe("www.codebuddy.cn")
    expect(conn.headers?.["X-User-Id"]).toBe("u1")
    expect(conn.headers?.["X-Enterprise-Id"]).toBe("e1")
    expect(conn.headers?.["X-Tenant-Id"]).toBe("e1")
    expect(getConnectionProvider(conn)).toBe("codebuddy-cn")
    expect(conn.name).toBe("CodeBuddy-nick")
  })

  test("keeps custom label", () => {
    const conn = emptyConnection("my-label")
    applyCodebuddyOAuthBundle(conn, "codebuddy", {
      accessToken: "access-1",
      nickname: "nick",
    })
    expect(conn.name).toBe("my-label")
    expect(conn.baseUrl).toBe("https://www.workbuddy.ai/v2")
    expect(conn.headers?.["X-Domain"]).toBe("www.workbuddy.ai")
    expect(getConnectionProvider(conn)).toBe("codebuddy")
  })
})
