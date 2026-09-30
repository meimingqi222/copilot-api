import { afterEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"
import {
  getOAuthProviderDescriptor,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import { parseZcodeQuota } from "~/lib/quota/fetchers/zcode"
import {
  applyZcodeOAuthBundle,
  mintZcodeKey,
  startZcodeSignIn,
  ZCODE_API,
  ZCODE_ZAI_ANTHROPIC_BASE,
} from "~/services/oauth/zcode"
import {
  getOAuthStrategy,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import { OAUTH_REFRESH_STRATEGIES } from "~/services/oauth/refresh-strategies"
import { zcodeNativeAdapter } from "~/services/protocols/zcode-native"

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

function createConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  const now = Date.now()
  return {
    id: "zcode-oauth-test",
    name: "ZCode",
    protocol: "zcode-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred-zcode",
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
    ...overrides,
  }
}

describe("zcode registration", () => {
  test("zcode is an OAuth provider on the zcode-native protocol", () => {
    expect(OAUTH_PROVIDER_IDS).toContain("zcode")
    expect(isOAuthProviderId("zcode")).toBe(true)
    expect(PROVIDER_PROTOCOL_MAP.zcode).toBe("zcode-native")
    expect(getOAuthProviderDescriptor("zcode").authMode).toBe("oauth")
  })

  test("strategy and refresh wiring exist", () => {
    expect(OAUTH_PROVIDER_STRATEGIES.zcode.flowType).toBe("device")
    expect(getOAuthStrategy("zcode")).toBe(OAUTH_PROVIDER_STRATEGIES.zcode)
    expect(typeof OAUTH_REFRESH_STRATEGIES.zcode).toBe("function")
  })
})

describe("zcode sign-in start", () => {
  test("parses the flow and appends the redirect", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`${ZCODE_API}/api/v1/oauth/cli/init`)
      expect(
        (init?.headers as Record<string, string> | undefined)?.authorization,
      ).toMatch(/^Bearer [0-9a-f]{64}$/)
      return jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-1",
          authorize_url: "https://z.ai/login?x=1",
          poll_interval_sec: 3,
          expires_at: Math.floor(Date.now() / 1000) + 300,
        },
      })
    }) as unknown as typeof fetch

    const start = await startZcodeSignIn("zai")
    expect(start.flowId).toBe("flow-1")
    const url = new URL(start.authUrl)
    expect(url.searchParams.get("redirect_uri")).toContain(
      "/app/oauth/login?redirect=",
    )
    expect(start.pollToken).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("zcode key minting", () => {
  test("finds an existing zcode-api-key and reads its secret", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url)
      if (target.endsWith("/api/biz/customer/getCustomerInfo")) {
        return jsonResponse({
          code: 0,
          data: {
            organizations: [
              {
                organizationId: "org-1",
                organizationName: "默认机构",
                projects: [
                  { projectId: "p-1", projectName: "默认项目", projectType: 1 },
                ],
              },
            ],
          },
        })
      }
      if (target.includes("/api_keys/copy/")) {
        return jsonResponse({ code: 0, data: { secretKey: "sec-xyz" } })
      }
      if (target.endsWith("/api_keys")) {
        return jsonResponse({
          code: 0,
          data: [{ name: "zcode-api-key", apiKey: "key-123" }],
        })
      }
      throw new Error(`unexpected ${target}`)
    }) as unknown as typeof fetch

    const key = await mintZcodeKey("zai", "Bearer biz")
    expect(key).toBe("key-123.sec-xyz")
  })
})

describe("zcode credential landing", () => {
  test("applyZcodeOAuthBundle stores key + base + site", () => {
    const conn = createConnection()
    applyZcodeOAuthBundle(conn, {
      base: ZCODE_ZAI_ANTHROPIC_BASE,
      apiKey: "key-123.sec-xyz",
      site: "zai",
      email: "dev@example.com",
    })
    const cred = conn.credentials[0]!
    expect(cred.value).toBe("key-123.sec-xyz")
    expect(cred.context?.base).toBe(ZCODE_ZAI_ANTHROPIC_BASE)
    expect(cred.context?.site).toBe("zai")
  })
})

describe("zcode-native adapter", () => {
  test("posts to the Anthropic endpoint with x-api-key + Bearer", async () => {
    let seen = ""
    let headers: Record<string, string> = {}
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen = String(url)
      headers = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify({ id: "m", content: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    const conn = createConnection()
    conn.credentials[0]!.value = "key-123.sec-xyz"
    await zcodeNativeAdapter.createMessages!({
      target: {} as never,
      connection: conn,
      credential: conn.credentials[0]!,
      payload: { model: "GLM-5.3", messages: [] } as never,
    })
    expect(seen).toBe(`${ZCODE_ZAI_ANTHROPIC_BASE}/v1/messages`)
    expect(headers["x-api-key"]).toBe("key-123.sec-xyz")
    expect(headers["Authorization"]).toBe("Bearer key-123.sec-xyz")
  })
})

describe("zcode quota parsing", () => {
  test("reads 5h + weekly windows from percentage and usage", () => {
    const parsed = parseZcodeQuota({
      level: "pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 20 },
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 7,
          usage: 1000,
          remaining: 400,
        },
      ],
    })
    expect(parsed).toBeDefined()
    const names = parsed!.windows.map((w) => w.name)
    expect(names).toContain("5 hours")
    expect(names).toContain("7 days")
    const weekly = parsed!.windows.find((w) => w.name === "7 days")!
    expect(weekly.usedPercent).toBeCloseTo(60, 5)
  })
})
