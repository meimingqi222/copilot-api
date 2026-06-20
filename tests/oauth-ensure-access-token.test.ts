import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { OAuthAccount } from "~/lib/accounts"

import { state } from "~/lib/state"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"

const originalAccounts = state.accounts
const originalFetch = globalThis.fetch

beforeEach(() => {
  state.accounts = []
})

afterEach(() => {
  state.accounts = originalAccounts
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
    state.accounts = [account]

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
})
