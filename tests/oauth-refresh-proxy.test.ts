import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { OAuthAccount } from "~/lib/accounts"

import { state } from "~/lib/state"
import { refreshOAuthAccountToken } from "~/services/oauth/refresh-scheduler"

import { setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = state.accounts
const originalFetch = globalThis.fetch

beforeEach(() => {
  setTestAccounts([])
})

afterEach(() => {
  setTestAccounts(originalAccounts)
  globalThis.fetch = originalFetch
})

describe("OAuth refresh proxy", () => {
  test("refreshOAuthAccountToken uses account proxyUrl", async () => {
    let capturedInit: (RequestInit & { proxy?: string }) | undefined
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init as RequestInit & { proxy?: string }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const account: OAuthAccount = {
      id: "acct-1",
      label: "claude-proxy",
      provider: "claude",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
      },
      settings: {
        proxyUrl: "http://127.0.0.1:7890",
      },
      runtimeState: { authStatus: "ready" },
    }
    setTestAccounts([account])

    await refreshOAuthAccountToken(account, "test")

    expect(capturedInit?.proxy).toBe("http://127.0.0.1:7890")
    expect(account.credentials?.accessToken).toBe("new-access")
  })
})
