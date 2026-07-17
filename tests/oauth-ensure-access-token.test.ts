import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { OAuthAccount } from "~/lib/accounts"

import { listAccounts } from "~/lib/accounts"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"

import { setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listAccounts()
const originalFetch = globalThis.fetch

beforeEach(() => {
  setTestAccounts([])
})

afterEach(() => {
  setTestAccounts(originalAccounts)
  globalThis.fetch = originalFetch
})

describe("ensureOAuthAccessToken", () => {
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

    const account: OAuthAccount = {
      id: "acct-1",
      label: "claude-1",
      provider: "claude",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "stale-access",
        refreshToken: "refresh-1",
        expiresAt: Date.now() - 1_000,
      },
      runtimeState: { authStatus: "ready" },
    }
    setTestAccounts([account])

    const token = await ensureOAuthAccessToken(account)
    expect(token).toBe("fresh-access")
    expect(account.credentials?.accessToken).toBe("fresh-access")
  })

  test("returns existing token when still valid", async () => {
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls++
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch

    const account: OAuthAccount = {
      id: "acct-2",
      label: "codex-1",
      provider: "codex",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "valid-access",
        refreshToken: "refresh-2",
        expiresAt: Date.now() + 3_600_000,
      },
      runtimeState: { authStatus: "ready" },
    }

    const token = await ensureOAuthAccessToken(account)
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

    const account: OAuthAccount = {
      id: "acct-xai-401",
      label: "xai-401",
      provider: "xai",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "invalid-access",
        refreshToken: "refresh-1",
        expiresAt: Date.now() + 3_600_000,
      },
      settings: { tokenEndpoint: "https://auth.x.ai/oauth2/token" },
      runtimeState: { authStatus: "ready" },
    }
    setTestAccounts([account])

    const response = await executeUpstreamProxyCall(account, {
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
})
