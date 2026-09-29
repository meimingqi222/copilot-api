import { afterEach, describe, expect, mock, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import {
  ensureLobsteraiAccessToken,
  cancelLobsteraiRefreshTimer,
} from "~/services/lobsterai/token-refresh"
import { OAUTH_CALLBACK_CONFIGS } from "~/services/oauth/flows"
import {
  createLobsteraiOAuthStart,
  exchangeLobsteraiCode,
  lobsteraiCallbackStateMatches,
  LOBSTERAI_REDIRECT_URI,
} from "~/services/oauth/lobsterai"
import { getOAuthStrategy } from "~/services/oauth/provider-strategies"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  cancelLobsteraiRefreshTimer("lobsterai-oauth-test")
  __resetProviderConnectionsForTest()
})

describe("LobsterAI browser login", () => {
  test("builds portal hash parameters and registers the loopback callback", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              value: "https://lobsterai.youdao.com/portal#/login?campaign=x",
            },
          }),
        ),
      ),
    ) as unknown as typeof fetch
    const start = await createLobsteraiOAuthStart()
    const url = new URL(start.authUrl)
    const params = new URLSearchParams(url.hash.split("?")[1])
    expect(params.get("campaign")).toBe("x")
    expect(params.get("source")).toBe("electron")
    expect(params.get("redirect_uri")).toBe(LOBSTERAI_REDIRECT_URI)
    expect(params.get("state")).toBe(start.state)
    expect(getOAuthStrategy("lobsterai")?.flowType).toBe("callback")
    expect(OAUTH_CALLBACK_CONFIGS.lobsterai?.callbackPath).toBe(
      "/auth/callback",
    )
  })

  test("manual callback must carry the matching state", () => {
    expect(
      lobsteraiCallbackStateMatches(
        `${LOBSTERAI_REDIRECT_URI}?code=abc&state=expected`,
        "expected",
      ),
    ).toBe(true)
    expect(
      lobsteraiCallbackStateMatches(
        `${LOBSTERAI_REDIRECT_URI}?code=abc&state=other`,
        "expected",
      ),
    ).toBe(false)
    expect(lobsteraiCallbackStateMatches("code=abc", "expected")).toBe(false)
  })

  test("exchanges the code with the client fields and stores a Bearer credential", async () => {
    let sentBody: Record<string, string> = {}
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body)) as Record<string, string>
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              accessToken: "access-new",
              refreshToken: "refresh-new",
              expiresIn: 3600,
            },
          }),
        ),
      )
    }) as unknown as typeof fetch
    const tokens = await exchangeLobsteraiCode("auth-code", "install-uuid")
    expect(sentBody).toMatchObject({
      authCode: "auth-code",
      uuid: "install-uuid",
      version: "1.0.0",
      firstKeyfrom: "official",
      latestKeyfrom: "official",
    })
    const strategy = getOAuthStrategy("lobsterai")
    const conn = await strategy?.exchange({
      flow: { label: "LobsterAI", nonce: "install-uuid" } as never,
      code: "auth-code",
    })
    expect(tokens?.accessToken).toBe("access-new")
    expect(conn?.protocol).toBe("lobsterai-native")
    expect(conn?.credentials[0]?.authMode).toBe("bearer")
    expect(conn?.credentials[0]?.context?.refreshToken).toBe("refresh-new")
  })
})

describe("LobsterAI token renewal", () => {
  test("coalesces request-time refresh and rotates both tokens", async () => {
    const now = Date.now()
    const conn = {
      id: "lobsterai-oauth-test",
      name: "LobsterAI",
      protocol: "lobsterai-native",
      baseUrl: "https://lobsterai-server.youdao.com",
      enabled: true,
      priority: 0,
      credentials: [
        {
          id: "cred",
          authMode: "bearer",
          value: "old-access",
          enabled: true,
          status: "ready",
          context: { refreshToken: "old-refresh", expiresAt: now - 1000 },
          createdAt: now,
        },
      ],
      models: [],
      createdAt: now,
      updatedAt: now,
    } as ProviderConnection
    upsertProviderConnection(conn)
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              accessToken: "new-access",
              refreshToken: "new-refresh",
              expiresIn: 3600,
            },
          }),
        ),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const [first, second] = await Promise.all([
      ensureLobsteraiAccessToken(conn, conn.credentials[0]),
      ensureLobsteraiAccessToken(conn, conn.credentials[0]),
    ])
    expect([first, second]).toEqual(["new-access", "new-access"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(conn.credentials[0]?.value).toBe("new-access")
    expect(conn.credentials[0]?.context?.refreshToken).toBe("new-refresh")
  })
})
