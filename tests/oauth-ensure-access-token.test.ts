import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { listAccounts } from "~/lib/legacy-accounts"
import {
  getConnectionAuthStatus,
  getMutableProviderConnection,
  upsertProviderConnection,
  type ProviderConnection,
  type ProviderProtocol,
} from "~/lib/provider-connections"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import {
  cancelAllOAuthRefreshTimers,
  refreshOAuthConnectionToken,
} from "~/services/oauth/refresh-scheduler"

import { setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listAccounts()
const originalFetch = globalThis.fetch

beforeEach(() => {
  setTestAccounts([])
})

afterEach(() => {
  cancelAllOAuthRefreshTimers()
  setTestAccounts(originalAccounts)
  globalThis.fetch = originalFetch
})

/**
 * 创建 OAuth account-managed connection(替代直接构造 Account)。
 * Phase 3.4:测试已从 ensureOAuthAccessToken(account) 翻转为
 * ensureOAuthConnectionAccessToken(connection, credential)。
 */
function createOAuthConnection(
  id: string,
  provider: string,
  overrides: {
    enabled?: boolean
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    apiKey?: string
    email?: string
    tokenEndpoint?: string
  } = {},
): ProviderConnection {
  const now = Date.now()
  const protocolMap: Record<string, ProviderProtocol> = {
    claude: "claude-native",
    codex: "codex-native",
    xai: "xai-native",
    kimi: "kimi-native",
    antigravity: "antigravity-native",
  }
  const protocol: ProviderProtocol = protocolMap[provider] ?? "claude-native"
  const conn: ProviderConnection = {
    id,
    name: `${provider}-1`,
    protocol,
    baseUrl: "",
    enabled: overrides.enabled ?? true,
    priority: 0,
    credentials: [
      {
        id: `${id}-cred`,
        authMode: "bearer",
        value: overrides.accessToken ?? "",
        enabled: overrides.enabled ?? true,
        status: "ready",
        createdAt: now,
        context: {
          refreshToken: overrides.refreshToken,
          expiresAt: overrides.expiresAt,
          apiKey: overrides.apiKey,
          email: overrides.email,
          tokenEndpoint: overrides.tokenEndpoint,
        },
      },
    ],
    models: [],
    metadata: {
      provider,
      settings:
        overrides.tokenEndpoint ?
          { tokenEndpoint: overrides.tokenEndpoint }
        : {},
    },
    createdAt: now,
  }
  upsertProviderConnection(conn)
  return conn
}

function jwtWithExpiry(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url")
  return `header.${payload}.signature`
}

describe("ensureOAuthConnectionAccessToken", () => {
  test("refreshes expired access token before returning", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const conn = createOAuthConnection("acct-1", "claude", {
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1_000,
    })

    const credential = conn.credentials[0]
    const token = await ensureOAuthConnectionAccessToken(conn, credential)
    expect(token).toBe("fresh-access")
  })

  test("refreshes expired access token even when account is disabled", async () => {
    // A disabled account is only excluded from request routing, not from its
    // token lifecycle. On-demand actions (e.g. quota refresh) must still work.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const conn = createOAuthConnection("acct-disabled", "claude", {
      enabled: false,
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1_000,
    })

    const credential = conn.credentials[0]
    const token = await ensureOAuthConnectionAccessToken(conn, credential)
    expect(token).toBe("fresh-access")
  })

  test("uses the access-token JWT expiry when expiresAt is missing", async () => {
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      return Promise.resolve(
        Response.json({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    const conn = createOAuthConnection("acct-codex-jwt", "codex", {
      accessToken: jwtWithExpiry(Math.floor(Date.now() / 1000) - 60),
      refreshToken: "refresh-1",
    })

    const token = await ensureOAuthConnectionAccessToken(
      conn,
      conn.credentials[0],
    )
    expect(token).toBe("fresh-access")
    expect(fetchCalls).toBe(1)
  })

  test("deduplicates concurrent refreshes across request paths", async () => {
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      return new Promise<Response>((resolve) => {
        setTimeout(
          () =>
            resolve(
              Response.json({
                access_token: "fresh-access",
                refresh_token: "fresh-refresh",
                expires_in: 3600,
              }),
            ),
          10,
        )
      })
    }) as unknown as typeof fetch

    const conn = createOAuthConnection("acct-codex-concurrent", "codex", {
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1_000,
    })

    const tokens = await Promise.all([
      ensureOAuthConnectionAccessToken(conn, conn.credentials[0]),
      ensureOAuthConnectionAccessToken(conn, conn.credentials[0]),
    ])
    expect(tokens).toEqual(["fresh-access", "fresh-access"])
    expect(fetchCalls).toBe(1)
  })

  test("uses a concurrently refreshed live token when the caller holds a snapshot", async () => {
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      return Promise.resolve(new Response("unexpected", { status: 500 }))
    }) as unknown as typeof fetch

    const conn = createOAuthConnection("acct-codex-snapshot", "codex", {
      accessToken: "token-old",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
    })
    const snapshot = structuredClone(conn)
    conn.credentials[0].value = "token-new"

    const token = await ensureOAuthConnectionAccessToken(
      snapshot,
      snapshot.credentials[0],
      { forceRefresh: true, failedAccessToken: "token-old" },
    )
    expect(token).toBe("token-new")
    expect(fetchCalls).toBe(0)
  })

  test("keeps a credential routable after a transient refresh failure", async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        new TypeError("temporary network failure"),
      )) as unknown as typeof fetch

    const conn = createOAuthConnection("acct-codex-transient", "codex", {
      accessToken: "still-usable",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
    })

    await expect(refreshOAuthConnectionToken(conn, "test")).rejects.toThrow(
      "temporary network failure",
    )
    expect(getConnectionAuthStatus(conn)).toBe("ready")
  })

  test("returns existing token when still valid", async () => {
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls++
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch

    const conn = createOAuthConnection("acct-2", "codex", {
      accessToken: "valid-access",
      refreshToken: "refresh-2",
      expiresAt: Date.now() + 3_600_000,
    })

    const credential = conn.credentials[0]
    const token = await ensureOAuthConnectionAccessToken(conn, credential)
    expect(token).toBe("valid-access")
    expect(fetchCalls).toBe(0)
  })

  test("refreshes and retries an upstream request after 401", async () => {
    const authorizationHeaders: Array<string | null> = []
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      let url: string
      if (typeof input === "string") {
        url = input
      } else if (input instanceof URL) {
        url = input.href
      } else {
        url = input.url
      }
      if (url === "https://auth.x.ai/oauth2/token") {
        return Promise.resolve(
          Response.json({
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            expires_in: 3600,
          }),
        )
      }

      authorizationHeaders.push(new Headers(init?.headers).get("Authorization"))
      if (authorizationHeaders.length === 1) {
        return Promise.resolve(new Response("unauthorized", { status: 401 }))
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as typeof fetch

    const conn = createOAuthConnection("acct-xai-401", "xai", {
      accessToken: "invalid-access",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    })
    const connection = getMutableProviderConnection(conn.id)
    if (!connection) throw new Error("connection not found")

    const response = await executeUpstreamProxyCall(connection, {
      method: "GET",
      url: "https://cli-chat-proxy.grok.com/v1/billing",
      headers: { Authorization: "Bearer $TOKEN$" },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe("ok")
    expect(authorizationHeaders).toEqual([
      "Bearer invalid-access",
      "Bearer fresh-access",
    ])
  })

  test("prefers the OAuth access token over a present static api key", async () => {
    // CPA request-path precedence: access_token first, static api_key only as a
    // fallback. An account carrying both must send the OAuth bearer token.
    const authorizationHeaders: Array<string | null> = []
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      authorizationHeaders.push(new Headers(init?.headers).get("Authorization"))
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as typeof fetch

    const conn = createOAuthConnection("acct-both-creds", "xai", {
      accessToken: "oauth-access",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
      apiKey: "xai-static-key",
    })
    const connection = getMutableProviderConnection(conn.id)
    if (!connection) throw new Error("connection not found")

    const response = await executeUpstreamProxyCall(connection, {
      method: "GET",
      url: "https://cli-chat-proxy.grok.com/v1/billing",
      headers: { Authorization: "Bearer $TOKEN$" },
    })

    expect(response.statusCode).toBe(200)
    expect(authorizationHeaders).toEqual(["Bearer oauth-access"])
  })
})
