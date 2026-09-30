import { afterEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"
import {
  getOAuthProviderDescriptor,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import { parseFactoryQuota } from "~/lib/quota/fetchers/factory"
import {
  applyFactoryOAuthBundle,
  FACTORY_API_BASE,
  FACTORY_API_EU_BASE,
  factoryApiBase,
  pollFactoryDeviceAuthorization,
  startFactoryDeviceFlow,
} from "~/services/oauth/factory"
import {
  getOAuthStrategy,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import {
  OAUTH_REFRESH_LEAD_MS,
  OAUTH_REFRESH_STRATEGIES,
} from "~/services/oauth/refresh-strategies"
import { factoryNativeAdapter } from "~/services/protocols/factory-native"

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
    id: "factory-oauth-test",
    name: "Factory",
    protocol: "factory-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred-factory",
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

describe("factory registration", () => {
  test("factory is an OAuth provider on the factory-native protocol", () => {
    expect(OAUTH_PROVIDER_IDS).toContain("factory")
    expect(isOAuthProviderId("factory")).toBe(true)
    expect(PROVIDER_PROTOCOL_MAP.factory).toBe("factory-native")
    expect(getOAuthProviderDescriptor("factory").authMode).toBe("oauth")
    expect(getOAuthProviderDescriptor("factory").features).toContain("oauth")
  })

  test("strategy and refresh wiring exist", () => {
    expect(OAUTH_PROVIDER_STRATEGIES.factory.flowType).toBe("device")
    expect(getOAuthStrategy("factory")).toBe(OAUTH_PROVIDER_STRATEGIES.factory)
    expect(typeof OAUTH_REFRESH_STRATEGIES.factory).toBe("function")
    expect(OAUTH_REFRESH_LEAD_MS.factory).toBeGreaterThan(0)
  })
})

describe("factory device flow", () => {
  test("start reads the device code", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      expect(String(url)).toContain("/authorize/device")
      return jsonResponse({
        device_code: "dc-123",
        user_code: "USER-1",
        verification_uri: "https://factory.ai/device",
        verification_uri_complete: "https://factory.ai/device?code=USER-1",
        interval: 1,
      })
    }) as unknown as typeof fetch

    const device = await startFactoryDeviceFlow()
    expect(device.device_code).toBe("dc-123")
    expect(device.user_code).toBe("USER-1")
    expect(device.interval).toBe(1)
  })

  test("poll waits through authorization_pending then lands tokens", async () => {
    let calls = 0
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.includes("/authenticate")) {
        calls += 1
        if (calls === 1) return jsonResponse({ error: "authorization_pending" })
        return jsonResponse({
          access_token: "at-1",
          refresh_token: "rt-1",
          organization_id: "org_workos",
          user: { id: "u-1", email: "dev@example.com" },
        })
      }
      // whoami
      expect(init?.headers).toBeDefined()
      return jsonResponse({
        userId: "u-1",
        orgId: "org_active",
        email: "dev@example.com",
        region: "eu",
      })
    }) as unknown as typeof fetch

    const bundle = await pollFactoryDeviceAuthorization({
      device_code: "dc-123",
      user_code: "USER-1",
      verification_uri: "https://factory.ai/device",
      interval: 0,
    })
    expect(bundle.accessToken).toBe("at-1")
    expect(bundle.refreshToken).toBe("rt-1")
    expect(bundle.organizationId).toBe("org_active")
    expect(bundle.region).toBe("eu")
    expect(calls).toBe(2)
  })
})

describe("factory credential landing", () => {
  test("applyFactoryOAuthBundle stores token + org + region", () => {
    const conn = createConnection()
    applyFactoryOAuthBundle(conn, {
      accessToken: "at-1",
      refreshToken: "rt-1",
      organizationId: "org_active",
      workosOrgId: "org_workos",
      email: "dev@example.com",
      userId: "u-1",
      region: "eu",
    })
    const cred = conn.credentials[0]!
    expect(cred.value).toBe("at-1")
    expect(cred.context?.refreshToken).toBe("rt-1")
    expect(cred.context?.organizationId).toBe("org_active")
    expect(cred.context?.region).toBe("eu")
    expect(cred.status).toBe("ready")
  })

  test("factoryApiBase switches to the EU domain", () => {
    expect(factoryApiBase(undefined)).toBe(FACTORY_API_BASE)
    expect(factoryApiBase("eu")).toBe(FACTORY_API_EU_BASE)
  })
})

describe("factory-native adapter wire selection", () => {
  test("messages go to /api/llm/a/v1/messages", async () => {
    let seen = ""
    globalThis.fetch = (async (url: string | URL) => {
      seen = String(url)
      return new Response(JSON.stringify({ id: "m", content: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    await factoryNativeAdapter.createMessages!({
      target: {} as never,
      connection: createConnection(),
      credential: createConnection().credentials[0]!,
      payload: { model: "claude-sonnet-5", messages: [] } as never,
    })
    expect(seen).toBe(`${FACTORY_API_BASE}/api/llm/a/v1/messages`)
  })

  test("responses go to /api/llm/o/v1/responses", async () => {
    let seen = ""
    globalThis.fetch = (async (url: string | URL) => {
      seen = String(url)
      return new Response(JSON.stringify({ id: "r", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    await factoryNativeAdapter.createResponses!({
      target: {} as never,
      connection: createConnection(),
      credential: createConnection().credentials[0]!,
      payload: { model: "gpt-5.5", input: [] } as never,
    })
    expect(seen).toBe(`${FACTORY_API_BASE}/api/llm/o/v1/responses`)
  })
})

describe("factory quota parsing", () => {
  test("reads standard + core windows and extra balance", () => {
    const parsed = parseFactoryQuota({
      limits: {
        standard: {
          fiveHour: { usedPercent: 20, windowEnd: "2030-01-01T00:00:00Z" },
          weekly: { usedPercent: 45, windowEnd: 1893456000000 },
        },
        core: { fiveHour: { usedPercent: 10 } },
      },
      extraUsageBalanceCents: 500,
      extraUsageAllowed: true,
    })
    expect(parsed).toBeDefined()
    const names = parsed!.windows.map((w) => w.name)
    expect(names).toContain("5 hours")
    expect(names).toContain("7 days")
    expect(names).toContain("Droid Core · 5 hours")
    expect(parsed!.extraBalanceCents).toBe(500)
  })

  test("missing extra allowance hides the balance", () => {
    const parsed = parseFactoryQuota({
      limits: { standard: { fiveHour: { usedPercent: 5 } } },
      extraUsageBalanceCents: 100,
      extraUsageAllowed: false,
    })
    expect(parsed!.extraBalanceCents).toBeUndefined()
  })
})
