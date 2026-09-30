import { afterEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"
import {
  getOAuthProviderDescriptor,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import {
  applyGeminiOAuthBundle,
  buildGeminiAuthUrl,
  exchangeGeminiCode,
  GEMINI_AUTHORIZE_URL,
  GEMINI_CODE_ASSIST_BASE,
  geminiBundle,
  getGeminiClientId,
  newGeminiPkce,
  resolveGeminiProject,
} from "~/services/oauth/gemini"
import {
  getOAuthStrategy,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import { OAUTH_REFRESH_STRATEGIES } from "~/services/oauth/refresh-strategies"
import { geminiNativeAdapter } from "~/services/protocols/gemini-native"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function createConnection(): ProviderConnection {
  const now = Date.now()
  return {
    id: "gemini-oauth-test",
    name: "Gemini CLI",
    protocol: "gemini-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred-gem",
        authMode: "header",
        value: "google-token",
        enabled: true,
        status: "ready",
        context: { projectId: "proj-1" },
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

describe("gemini registration", () => {
  test("gemini is an OAuth provider on gemini-native", () => {
    expect(OAUTH_PROVIDER_IDS).toContain("gemini")
    expect(isOAuthProviderId("gemini")).toBe(true)
    expect(PROVIDER_PROTOCOL_MAP.gemini).toBe("gemini-native")
    expect(getOAuthProviderDescriptor("gemini").authMode).toBe("oauth")
  })

  test("strategy is pkce-callback and refresh is wired", () => {
    expect(OAUTH_PROVIDER_STRATEGIES.gemini.flowType).toBe("pkce-callback")
    expect(getOAuthStrategy("gemini")).toBe(OAUTH_PROVIDER_STRATEGIES.gemini)
    expect(typeof OAUTH_REFRESH_STRATEGIES.gemini).toBe("function")
  })
})

describe("gemini auth url + exchange", () => {
  test("auth url carries Gemini CLI's client and offline access", () => {
    const url = new URL(buildGeminiAuthUrl("state-1", newGeminiPkce()))
    expect(url.origin + url.pathname).toBe(
      new URL(GEMINI_AUTHORIZE_URL).origin
        + new URL(GEMINI_AUTHORIZE_URL).pathname,
    )
    expect(url.searchParams.get("client_id")).toBe(getGeminiClientId())
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  })

  test("exchange posts the pkce verifier", async () => {
    let form = ""
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("oauth2.googleapis.com/token")
      form = String(init?.body)
      return jsonResponse({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
      })
    }) as unknown as typeof fetch
    const pkce = newGeminiPkce()
    await exchangeGeminiCode("the-code", pkce)
    expect(new URLSearchParams(form).get("code_verifier")).toBe(
      pkce.codeVerifier,
    )
    expect(new URLSearchParams(form).get("grant_type")).toBe(
      "authorization_code",
    )
  })
})

describe("gemini Code Assist project", () => {
  test("reads the project from loadCodeAssist", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      expect(String(url)).toBe(
        `${GEMINI_CODE_ASSIST_BASE}/v1internal:loadCodeAssist`,
      )
      return jsonResponse({
        currentTier: { id: "standard-tier", name: "Standard" },
        cloudaicompanionProject: "proj-xyz",
      })
    }) as unknown as typeof fetch
    const project = await resolveGeminiProject("at")
    expect(project.project).toBe("proj-xyz")
    expect(project.plan).toBe("Standard")
  })

  test("applyGeminiOAuthBundle stores the token + project", () => {
    const conn = createConnection()
    applyGeminiOAuthBundle(
      conn,
      geminiBundle(
        { access_token: "at", refresh_token: "rt", expires_in: 60 },
        { project: "proj-xyz", plan: "Standard" },
        { email: "dev@example.com" },
      ),
    )
    expect(conn.credentials[0]!.value).toBe("at")
    expect(conn.credentials[0]!.context?.projectId).toBe("proj-xyz")
    expect(conn.credentials[0]!.context?.refreshToken).toBe("rt")
  })
})

describe("gemini-native adapter", () => {
  test("wraps the request in the envelope and unwraps the stream", async () => {
    let envelope: Record<string, unknown> = {}
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/v1internal:streamGenerateContent")
      envelope = JSON.parse(String(init?.body)) as Record<string, unknown>
      const sse = [
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } })}`,
        "",
      ].join("\n")
      return new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    }) as unknown as typeof fetch

    const conn = createConnection()
    const result = await geminiNativeAdapter.createGeminiGenerateContent!({
      target: { upstreamModelId: "gemini-3-pro" } as never,
      connection: conn,
      credential: conn.credentials[0]!,
      payload: { model: "gemini-3-pro", contents: [], stream: true } as never,
    })
    expect(envelope.model).toBe("gemini-3-pro")
    expect(envelope.project).toBe("proj-1")
    expect(typeof envelope.user_prompt_id).toBe("string")
    expect("model" in (envelope.request as Record<string, unknown>)).toBe(false)

    const events: Array<{ data?: string }> = []
    for await (const e of result.response as AsyncIterable<{ data?: string }>) {
      events.push(e)
    }
    expect(events).toHaveLength(1)
    expect(
      JSON.parse(events[0]!.data!).candidates[0].content.parts[0].text,
    ).toBe("hi")
  })
})
