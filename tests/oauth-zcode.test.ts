import { afterEach, describe, expect, spyOn, test } from "bun:test"

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
  __resetZcodeRouteCacheForTest,
  isZcodeStartPlanName,
  parseZcodeStartBalance,
  resolveZcodeRoute,
  shapeZcodeStartBody,
  zcodeActiveStartPlan,
  zcodeJwtExpired,
} from "~/services/zcode/start-plan"
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
  __resetZcodeRouteCacheForTest()
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

  test("applyZcodeOAuthBundle keeps the session JWT for the Start Plan", () => {
    const conn = createConnection()
    applyZcodeOAuthBundle(conn, {
      base: ZCODE_ZAI_ANTHROPIC_BASE,
      apiKey: "",
      site: "zai",
      jwt: "jwt-token",
    })
    const cred = conn.credentials[0]!
    expect(cred.context?.zcodeJwt).toBe("jwt-token")
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

describe("zcode Start Plan (temporary credits)", () => {
  function fakeJwt(expSec = Math.floor(Date.now() / 1000) + 3600): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url")
    return `${b64({ alg: "none" })}.${b64({ exp: expSec })}.sig`
  }

  function startPlanConnection(jwt = fakeJwt()): ProviderConnection {
    const conn = createConnection()
    conn.credentials[0]!.value = "key-123.sec-xyz"
    conn.credentials[0]!.context = {
      base: ZCODE_ZAI_ANTHROPIC_BASE,
      site: "zai",
      zcodeJwt: jwt,
    }
    return conn
  }

  test("twenty cold requests share one bounded probe and cancellation only drops its waiter", async () => {
    const conn = startPlanConnection()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let reads = 0
    let probeSignal: AbortSignal | undefined
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      reads++
      probeSignal = init?.signal ?? undefined
      await gate
      return jsonResponse({ code: 0, data: [{ status: "VALID" }] })
    }) as typeof fetch
    const abort = new AbortController()
    const canceled = resolveZcodeRoute(conn, conn.credentials[0]!, {
      signal: abort.signal,
    })
    const remaining = Array.from({ length: 19 }, () =>
      resolveZcodeRoute(conn, conn.credentials[0]!),
    )
    abort.abort(new Error("caller canceled"))
    await expect(canceled).rejects.toThrow("caller canceled")
    expect(probeSignal).toBeInstanceOf(AbortSignal)
    expect(probeSignal?.aborted).toBe(false)
    expect(reads).toBe(1)
    release()
    expect(await Promise.all(remaining)).toEqual(Array(19).fill("coding"))
  })

  test("route probes time out and preserve cached routes during background refresh", async () => {
    const conn = startPlanConnection()
    const timeout = spyOn(AbortSignal, "timeout")
    timeout.mockImplementation(() => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error("probe timeout")), 10)
      return controller.signal
    })
    let calls = 0
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      calls++
      if (calls === 1)
        return jsonResponse({ code: 0, data: [{ status: "VALID" }] })
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      })
    }) as typeof fetch
    try {
      expect(await resolveZcodeRoute(conn, conn.credentials[0]!)).toBe("coding")
      const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000)
      try {
        expect(await resolveZcodeRoute(conn, conn.credentials[0]!)).toBe(
          "coding",
        )
      } finally {
        clock.mockRestore()
      }
      // Let the shared timeout finish; the caller did not have to wait for it.
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(timeout).toHaveBeenCalledWith(15_000)
      expect(calls).toBe(3)
      __resetZcodeRouteCacheForTest()
      expect(await resolveZcodeRoute(conn, conn.credentials[0]!)).toBe("coding")
    } finally {
      timeout.mockRestore()
    }
  })

  test("route follows the subscription list", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/api/biz/subscription/list")) {
        return jsonResponse({ code: 0, data: [] })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch
    const route = await resolveZcodeRoute(
      startPlanConnection(),
      startPlanConnection().credentials[0]!,
    )
    expect(route).toBe("start")
  })

  test("route stays on the coding plan while a subscription is VALID", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/api/biz/subscription/list")) {
        return jsonResponse({
          code: 0,
          data: [{ productName: "GLM Coding Plan", status: "VALID" }],
        })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch
    const conn = startPlanConnection()
    expect(await resolveZcodeRoute(conn, conn.credentials[0]!)).toBe("coding")
  })

  test("route falls back to an active Start Plan when subscriptions fail", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url)
      if (target.includes("/api/biz/subscription/list")) {
        return new Response("boom", { status: 500 })
      }
      if (target.includes("/api/v1/zcode-plan/billing/balance")) {
        return jsonResponse({
          code: 0,
          data: {
            plans: [
              {
                plan_id: "start-plan",
                user_plan_id: "up1",
                name: "Start Plan",
                status: "active",
                ends_at: Math.floor(Date.now() / 1000) + 86400,
                entitlements: [{ entitlement_id: "e1", period: "daily" }],
              },
            ],
            balances: [
              {
                plan_id: "start-plan",
                user_plan_id: "up1",
                entitlement_id: "e1",
                show_name: "GLM-5.2",
                capabilities: ["model:GLM-5.2"],
                total_units: 5000,
                used_units: 0,
                remaining_units: 5000,
              },
            ],
          },
        })
      }
      throw new Error(`unexpected ${target}`)
    }) as unknown as typeof fetch
    const conn = startPlanConnection()
    expect(await resolveZcodeRoute(conn, conn.credentials[0]!)).toBe("start")
  })

  test("no JWT never leaves the coding plan", async () => {
    const conn = createConnection()
    conn.credentials[0]!.value = "key-123.sec-xyz"
    conn.credentials[0]!.context = { base: ZCODE_ZAI_ANTHROPIC_BASE }
    expect(await resolveZcodeRoute(conn, conn.credentials[0]!)).toBe("coding")
  })
})

describe("zcode Start Plan balance parsing", () => {
  test("expired plans take their buckets with them (temporary credits)", () => {
    const now = Math.floor(Date.now() / 1000)
    const balance = parseZcodeStartBalance({
      server_time: now,
      plans: [
        {
          plan_id: "temp-credits",
          user_plan_id: "up1",
          name: "活动积分",
          status: "active",
          ends_at: now - 10,
          entitlements: [],
        },
        {
          plan_id: "start-plan",
          user_plan_id: "up2",
          name: "Start Plan",
          status: "active",
          ends_at: now + 86400,
          entitlements: [{ entitlement_id: "e2", period: "daily" }],
        },
      ],
      balances: [
        {
          plan_id: "temp-credits",
          user_plan_id: "up1",
          entitlement_id: "e1",
          total_units: 100,
          remaining_units: 100,
        },
        {
          plan_id: "start-plan",
          user_plan_id: "up2",
          entitlement_id: "e2",
          show_name: "GLM-5.2",
          total_units: 5000,
          used_units: 1000,
          remaining_units: 4000,
          expires_at: now + 86400,
        },
      ],
    })
    expect(balance.balances).toHaveLength(1)
    expect(balance.balances[0]!.planId).toBe("start-plan")
    const active = zcodeActiveStartPlan(balance)
    expect(active?.name).toBe("Start Plan")
    expect(active?.untilMs).toBe((now + 86400) * 1000)
  })

  test("plan name matching covers start-plan and 体验", () => {
    expect(isZcodeStartPlanName("Start Plan")).toBe(true)
    expect(isZcodeStartPlanName("zai-start-plan")).toBe(true)
    expect(isZcodeStartPlanName("体验套餐")).toBe(true)
    expect(isZcodeStartPlanName("GLM Coding Pro")).toBe(false)
  })

  test("jwt expiry is read from exp", () => {
    expect(
      zcodeJwtExpired(
        `a.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.b`,
      ),
    ).toBe(true)
    expect(zcodeJwtExpired("not-a-jwt")).toBe(false)
  })
})

describe("zcode Start Plan request shaping", () => {
  test("system is replaced by ZCode blocks, date reminder prepended, cache moved to the last turn", () => {
    const body = shapeZcodeStartBody(
      {
        model: "GLM-5.2",
        system: [{ type: "text", text: "agent system" }],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hi",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          { role: "assistant", content: "hello" },
        ],
        tools: [{ name: "t", cache_control: { type: "ephemeral" } }],
      },
      "zai-api",
      new Date("2026-10-03T12:00:00+08:00"),
    )
    const system = body.system as Array<Record<string, unknown>>
    expect(system).toHaveLength(4)
    expect(system[0]!.text).toBe("You are ZCode, an interactive coding agent")
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" })
    expect(system[3]!).toEqual({ type: "text", text: "agent system" })

    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]!.role).toBe("user")
    const reminder = messages[0]!.content as Array<Record<string, unknown>>
    expect(String(reminder[0]!.text)).toContain("<system-reminder>")
    expect(String(reminder[0]!.text)).toContain("Today's date is 2026-10-03")

    // 中间块的 cache_control 被清掉，最后一条消息的最后一块补上。
    const firstUser = messages[1]!.content as Array<Record<string, unknown>>
    expect(firstUser[0]!.cache_control).toBeUndefined()
    const lastMsg = messages[messages.length - 1]!
    const lastContent = lastMsg.content as Array<Record<string, unknown>>
    expect(lastContent[lastContent.length - 1]!.cache_control).toEqual({
      type: "ephemeral",
    })

    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools[0]!.cache_control).toBeUndefined()

    const meta = body.metadata as Record<string, unknown>
    const userId = JSON.parse(String(meta.user_id)) as { device_id: string }
    expect(userId.device_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("a body already carrying the ZCode prefix is left alone", () => {
    const sys = [
      { type: "text", text: "You are ZCode, an interactive coding agent" },
    ]
    const shaped = shapeZcodeStartBody(
      { messages: [{ role: "user", content: "hi" }], system: sys },
      "zai-api",
    )
    expect(shaped.system).toBe(sys)
  })
})

describe("zcode-native adapter — Start Plan", () => {
  function fakeJwt(expSec = Math.floor(Date.now() / 1000) + 3600): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url")
    return `${b64({ alg: "none" })}.${b64({ exp: expSec })}.sig`
  }

  function startConn(jwt = fakeJwt()): ProviderConnection {
    const conn = createConnection()
    conn.credentials[0]!.value = "key-123.sec-xyz"
    conn.credentials[0]!.context = {
      base: ZCODE_ZAI_ANTHROPIC_BASE,
      zcodeJwt: jwt,
    }
    return conn
  }

  function stubStartPlan(): void {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.includes("/api/biz/subscription/list")) {
        return jsonResponse({ code: 0, data: [] })
      }
      if (target.includes("/api/v1/zcode-plan/anthropic/v1/messages")) {
        const headers = init?.headers as Record<string, string>
        expect(headers.Authorization).toMatch(/^Bearer .+\..+\..+$/)
        expect(headers["x-api-key"]).toBeUndefined()
        expect(headers["X-ZCode-App-Version"]).toBe("3.14.3")
        expect(headers["X-Title"]).toBe("Z Code@cli")
        expect(headers["anthropic-beta"]).toBeUndefined()
        return new Response(JSON.stringify({ id: "m", content: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`unexpected ${target}`)
    }) as unknown as typeof fetch
  }

  test("a Start Plan account posts JWT + ZCode fingerprint to zcode.z.ai", async () => {
    stubStartPlan()
    const conn = startConn()
    await zcodeNativeAdapter.createMessages!({
      target: { upstreamModelId: "GLM-5.2" } as never,
      connection: conn,
      credential: conn.credentials[0]!,
      payload: {
        model: "GLM-5.2",
        messages: [{ role: "user", content: "hi" }],
        system: "you are helpful",
      } as never,
    })
  })

  test("GLM-5.3 is refused on the Start Plan before any upstream call", async () => {
    stubStartPlan()
    const conn = startConn()
    await expect(
      zcodeNativeAdapter.createMessages!({
        target: { upstreamModelId: "GLM-5.3" } as never,
        connection: conn,
        credential: conn.credentials[0]!,
        payload: { model: "GLM-5.3", messages: [] } as never,
      }),
    ).rejects.toThrow("Start Plan does not serve GLM-5.3")
  })

  test("an expired JWT asks to sign in again", async () => {
    stubStartPlan()
    const conn = startConn(fakeJwt(1))
    await expect(
      zcodeNativeAdapter.createMessages!({
        target: { upstreamModelId: "GLM-5.2" } as never,
        connection: conn,
        credential: conn.credentials[0]!,
        payload: { model: "GLM-5.2", messages: [] } as never,
      }),
    ).rejects.toThrow("sign-in has expired")
  })

  test("a 405 unusual-activity block is explained, not forwarded raw", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url)
      if (target.includes("/api/biz/subscription/list")) {
        return jsonResponse({ code: 0, data: [] })
      }
      if (target.includes("/api/v1/zcode-plan/anthropic/v1/messages")) {
        return new Response(
          JSON.stringify({
            code: 3012,
            msg: "request has been blocked due to unusual activity",
          }),
          { status: 405, headers: { "Content-Type": "application/json" } },
        )
      }
      throw new Error(`unexpected ${target}`)
    }) as unknown as typeof fetch
    const conn = startConn()
    await expect(
      zcodeNativeAdapter.createMessages!({
        target: { upstreamModelId: "GLM-5.2" } as never,
        connection: conn,
        credential: conn.credentials[0]!,
        payload: {
          model: "GLM-5.2",
          messages: [{ role: "user", content: "hi" }],
        } as never,
      }),
    ).rejects.toThrow("turned this request away")
  })
})
