import { afterEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"
import {
  getOAuthProviderDescriptor,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import { parseDimagentQuota } from "~/lib/quota/fetchers/dimagent"
import {
  applyDimagentOAuthBundle,
  buildDimagentAuthUrl,
  DIMAGENT_BASE,
  DIMAGENT_CLIENT_ID,
  DIMAGENT_REDIRECT_URI,
  dimagentBundle,
  exchangeDimagentCode,
  newDimagentPkce,
} from "~/services/oauth/dimagent"
import {
  getOAuthStrategy,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import { OAUTH_REFRESH_STRATEGIES } from "~/services/oauth/refresh-strategies"
import { dimagentNativeAdapter } from "~/services/protocols/dimagent-native"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
})

function createConnection(): ProviderConnection {
  const now = Date.now()
  return {
    id: "dimagent-oauth-test",
    name: "DimAgent",
    protocol: "dimagent-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred-da",
        authMode: "header",
        value: "da-token",
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

describe("dimagent registration", () => {
  test("dimagent is an OAuth provider on dimagent-native", () => {
    expect(OAUTH_PROVIDER_IDS).toContain("dimagent")
    expect(isOAuthProviderId("dimagent")).toBe(true)
    expect(PROVIDER_PROTOCOL_MAP.dimagent).toBe("dimagent-native")
    expect(getOAuthProviderDescriptor("dimagent").authMode).toBe("oauth")
  })

  test("strategy is pkce-callback and refresh is wired", () => {
    expect(OAUTH_PROVIDER_STRATEGIES.dimagent.flowType).toBe("pkce-callback")
    expect(getOAuthStrategy("dimagent")).toBe(
      OAUTH_PROVIDER_STRATEGIES.dimagent,
    )
    expect(typeof OAUTH_REFRESH_STRATEGIES.dimagent).toBe("function")
  })
})

describe("dimagent auth url + exchange", () => {
  test("auth url carries the fixed client and redirect", () => {
    const pkce = newDimagentPkce()
    const url = new URL(buildDimagentAuthUrl("state-1", pkce))
    expect(url.origin).toBe(DIMAGENT_BASE)
    expect(url.pathname).toBe("/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe(DIMAGENT_CLIENT_ID)
    expect(url.searchParams.get("redirect_uri")).toBe(DIMAGENT_REDIRECT_URI)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("state-1")
    expect(url.searchParams.get("source")).toBe("app")
  })

  test("exchange posts the pkce verifier and reads the token", async () => {
    let form = ""
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`${DIMAGENT_BASE}/oauth/token`)
      form = String(init?.body)
      return new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const pkce = newDimagentPkce()
    const tokens = await exchangeDimagentCode("the-code", pkce)
    const params = new URLSearchParams(form)
    expect(params.get("grant_type")).toBe("authorization_code")
    expect(params.get("code")).toBe("the-code")
    expect(params.get("code_verifier")).toBe(pkce.codeVerifier)
    expect(tokens.access_token).toBe("at")
  })

  test("applyDimagentOAuthBundle stores the token + refresh", () => {
    const conn = createConnection()
    applyDimagentOAuthBundle(
      conn,
      dimagentBundle({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 60,
      }),
    )
    expect(conn.credentials[0]!.value).toBe("at")
    expect(conn.credentials[0]!.context?.refreshToken).toBe("rt")
  })
})

describe("dimagent-native adapter", () => {
  test("posts to /v1/chat/completions with the desktop headers", async () => {
    let seen = ""
    let headers: Record<string, string> = {}
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen = String(url)
      headers = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify({ id: "c", choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    const conn = createConnection()
    await dimagentNativeAdapter.createChatCompletions!({
      target: {} as never,
      connection: conn,
      credential: conn.credentials[0]!,
      payload: { model: "dim-1", messages: [] } as never,
    })
    expect(seen).toBe(`${DIMAGENT_BASE}/v1/chat/completions`)
    expect(headers["Authorization"]).toBe("Bearer da-token")
    expect(headers["x-title"]).toBe("DimCode")
  })
})

describe("dimagent quota parsing", () => {
  test("reads a percentage or used/total", () => {
    expect(
      parseDimagentQuota({ used_percent: 42 }).windows[0]!.usedPercent,
    ).toBe(42)
    const w = parseDimagentQuota({ used: 30, total: 100 }).windows[0]!
    expect(w.usedPercent).toBeCloseTo(30, 5)
    // display 是「剩余 / 总量」，与 valueText/进度条口径一致
    expect(w.display).toBe("70 / 100")
  })
})
