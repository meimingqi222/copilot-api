import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import type { ProviderConnection } from "~/lib/provider-connections"

import {
  __resetProviderConnectionsForTest,
  getConnectionProxyUrl,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  getSystemSettings,
  initializeSystemConfig,
  updateSystemConfig,
} from "~/lib/system-config"
import {
  claimZcodePlan,
  fetchZcodeClaimPlans,
  isZcodeClaimCandidate,
  parseZcodeClaimPlans,
  readZcodeClaimState,
  runZcodeClaimRound,
  writeZcodeClaimState,
  ZcodeClaimError,
} from "~/services/zcode/claim"
import {
  __resetZcodeAppVersionForTest,
  ZCODE_APP_VERSION,
} from "~/services/oauth/zcode"
import {
  __resetZcodeCaptchaForTest,
  __setZcodeVerifyParamForTest,
} from "~/services/zcode/captcha"
import { __resetZcodeClaimRoundForTest } from "~/services/zcode/claim"

const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
  __resetZcodeCaptchaForTest()
  __resetZcodeAppVersionForTest()
  await __resetZcodeClaimRoundForTest()
})

function jwt(expSeconds?: number): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      exp: expSeconds ?? Math.floor(Date.now() / 1000) + 3600,
      user_id: "user-1",
    }),
    "sig",
  ].join(".")
}

function createConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  const now = Date.now()
  return {
    id: "zcode-claim-test",
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
        context: { zcodeJwt: jwt() },
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("zcode claim plan parsing", () => {
  test("sorts by priority and keeps only token model grants", () => {
    const plans = parseZcodeClaimPlans({
      plans: [
        {
          plan_id: "low",
          name: "Low",
          priority: 1,
          entitlements: [
            {
              meter: "model_usage",
              unit_type: "token",
              show_name: "GLM-5.3",
              grant_units: 1_000,
              period: "one_time",
            },
          ],
        },
        {
          plan_id: "high",
          name: "Weekend egg",
          priority: 9,
          entitlements: [
            { meter: "request_count", unit_type: "token", show_name: "noise" },
            {
              meter: "model_usage",
              unit_type: "token",
              show_name: "GLM-5.3-Flash",
              grant_units: "2000",
              period: "daily",
            },
          ],
        },
      ],
    })

    expect(plans.map((plan) => plan.planId)).toEqual(["high", "low"])
    expect(plans[0]!.name).toBe("Weekend egg")
    expect(plans[0]!.grants).toEqual([
      { name: "GLM-5.3-Flash", units: 2000, period: "daily" },
    ])
  })

  test("accepts the already-parsed stored shape and unwraps {data:{plans}}", () => {
    const stored = parseZcodeClaimPlans({
      plans: [
        {
          planId: "p1",
          name: "Stored",
          description: "",
          priority: 2,
          grants: [{ name: "GLM-5.3", units: 10, period: "one_time" }],
        },
      ],
    })
    expect(stored[0]!.grants[0]!.units).toBe(10)

    const wrapped = parseZcodeClaimPlans({
      data: { plans: [{ plan_id: "p2", name: "Nested" }] },
    })
    expect(wrapped.map((plan) => plan.planId)).toEqual(["p2"])
  })
})

describe("zcode claim client", () => {
  test("preview sends the session JWT and billing fingerprint headers", async () => {
    const connection = createConnection()
    let seenUrl = ""
    let seenHeaders: Record<string, string> = {}
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      seenUrl = String(input)
      seenHeaders = (init?.headers ?? {}) as Record<string, string>
      return jsonResponse({
        code: 0,
        data: {
          plans: [
            {
              plan_id: "weekend",
              name: "Weekend egg",
              priority: 5,
              entitlements: [
                {
                  meter: "model_usage",
                  unit_type: "token",
                  show_name: "GLM-5.3",
                  grant_units: 3_000_000,
                  period: "one_time",
                },
              ],
            },
          ],
        },
      })
    }) as unknown as typeof fetch

    const plans = await fetchZcodeClaimPlans(connection)

    expect(plans).toHaveLength(1)
    expect(plans[0]!.planId).toBe("weekend")
    expect(seenUrl).toContain("/api/v1/zcode-plan/billing/preview?")
    expect(seenUrl).toContain(`app_version=${ZCODE_APP_VERSION}`)
    expect(seenHeaders.authorization).toBe(
      `Bearer ${connection.credentials[0]!.context!.zcodeJwt}`,
    )
    // billing 必须带设备 id，缺了上游回 3001。
    expect(seenHeaders["X-Device-Mid"]).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
    )
    expect(seenHeaders["X-Title"]).toBe("Z Code@electron")
  })

  test("preview advertises a client version at or above the plan-delivery floor", async () => {
    // 上游按最低客户端版本投放限时套餐：2026-10-29 实测 3.14.4 → plans 为空，
    // 3.16.3（当时官方客户端版本）→ 投放 ZCODE GLOBAL BUILD。把常量降回旧版
    // 不会报错，只会让 preview 永远「暂无可领取套餐」，所以在这里钉住下限。
    const floor = [3, 16, 3]
    const version = ZCODE_APP_VERSION.split(".").map(Number)
    for (let i = 0; i < floor.length; i += 1) {
      if ((version[i] ?? 0) !== floor[i]!) {
        expect(version[i] ?? 0).toBeGreaterThan(floor[i]!)
        break
      }
    }

    const connection = createConnection()
    let seenUrl = ""
    globalThis.fetch = (async (url: string | URL) => {
      seenUrl = String(url)
      return jsonResponse({ code: 0, data: { plans: [] } })
    }) as unknown as typeof fetch

    await fetchZcodeClaimPlans(connection)
    expect(seenUrl).toContain(`app_version=${ZCODE_APP_VERSION}`)
  })

  test("preview treats an upstream 404 as 'no activity right now'", async () => {
    const connection = createConnection()
    globalThis.fetch = (async () =>
      jsonResponse(
        { code: 404, msg: "not found" },
        404,
      )) as unknown as typeof fetch

    expect(await fetchZcodeClaimPlans(connection)).toEqual([])
  })

  test("preview follows the version the official release manifest advertises", async () => {
    const connection = createConnection()
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input)
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      if (url.includes("/api/v1/releases/electron/manifest")) {
        return new Response("version: 9.9.9\nfiles: []\n", { status: 200 })
      }
      return jsonResponse({ code: 0, data: { plans: [] } })
    }) as unknown as typeof fetch

    await fetchZcodeClaimPlans(connection)

    const preview = calls.find((call) => call.url.includes("/billing/preview"))!
    expect(preview.url).toContain("app_version=9.9.9")
    expect(preview.headers["X-ZCode-App-Version"]).toBe("9.9.9")
    // 清单里给的是更新器平台键，不是 process.platform。
    const manifest = calls.find((call) =>
      call.url.includes("/releases/electron/manifest"),
    )!
    expect(manifest.url).toContain("channel=stable")
  })

  test("preview keeps the pinned version when the manifest is unreachable", async () => {
    const connection = createConnection()
    let seenUrl = ""
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/api/v1/releases/electron/manifest")) {
        return new Response("boom", { status: 503 })
      }
      seenUrl = url
      return jsonResponse({ code: 0, data: { plans: [] } })
    }) as unknown as typeof fetch

    await fetchZcodeClaimPlans(connection)
    expect(seenUrl).toContain(`app_version=${ZCODE_APP_VERSION}`)
  })

  test("the release manifest is asked at most once per batch of previews", async () => {
    const connection = createConnection()
    let manifestCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/api/v1/releases/electron/manifest")) {
        manifestCalls += 1
        return new Response("version: 9.9.9\n", { status: 200 })
      }
      return jsonResponse({ code: 0, data: { plans: [] } })
    }) as unknown as typeof fetch

    await fetchZcodeClaimPlans(connection)
    await fetchZcodeClaimPlans(connection)
    expect(manifestCalls).toBe(1)
  })

  test("claim posts the plan with the captcha headers", async () => {
    const connection = createConnection()
    let seenUrl = ""
    let seenInit: RequestInit | undefined
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      seenUrl = String(input)
      seenInit = init
      return jsonResponse({
        code: 0,
        data: {
          server_time: 1_700_000_000,
          plan: { starts_at: 1_700_000_100, ends_at: 1_700_086_800 },
        },
      })
    }) as unknown as typeof fetch

    const result = await claimZcodePlan(connection, {
      planId: "weekend",
      verifyParam: "verify-token",
      region: "cn",
    })

    expect(seenUrl).toContain("/api/v1/zcode-plan/billing/claim")
    expect(seenInit?.method).toBe("POST")
    expect(JSON.parse(String(seenInit?.body))).toEqual({ plan_id: "weekend" })
    const headers = seenInit?.headers as Record<string, string>
    expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBe("verify-token")
    expect(headers["X-Aliyun-Captcha-Verify-Region"]).toBe("cn")
    expect(result.planId).toBe("weekend")
    expect(result.endsAtMs).toBe(1_700_086_800_000)
    expect(result.startsAtMs).toBe(1_700_000_100_000)
  })

  test("a claim by planId takes its name and grants from the last preview", async () => {
    const connection = createConnection()
    writeZcodeClaimState(connection, {
      checkedAt: 1,
      plans: [
        {
          planId: "manual-plan",
          name: "ZCODE GLOBAL BUILD",
          description: "",
          priority: 111,
          grants: [
            { name: "GLM-5.3-Flash", units: 300_000_000, period: "one_time" },
          ],
        },
      ],
    })
    globalThis.fetch = (async () =>
      jsonResponse({
        code: 0,
        data: { server_time: 1_700_000_000, plan: { ends_at: 1_700_086_800 } },
      })) as unknown as typeof fetch

    const result = await claimZcodePlan(connection, {
      planId: "manual-plan",
      verifyParam: "verify-token",
      region: "cn",
    })

    expect(result.planName).toBe("ZCODE GLOBAL BUILD")
    expect(result.grants).toEqual([
      { name: "GLM-5.3-Flash", units: 300_000_000, period: "one_time" },
    ])
  })

  test("1005 becomes a hold with the recovery time from data.plan.ends_at", async () => {
    const connection = createConnection()
    globalThis.fetch = (async () =>
      jsonResponse({
        code: 1005,
        msg: "quota exhausted",
        data: { plan: { ends_at: 1_700_000_000 } },
      })) as unknown as typeof fetch

    const error = await claimZcodePlan(connection, {
      planId: "weekend",
      verifyParam: "verify-token",
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ZcodeClaimError)
    expect((error as ZcodeClaimError).code).toBe(1005)
    expect((error as ZcodeClaimError).nextAtMs).toBe(1_700_000_000_000)
  })

  test("3007 surfaces as a rejected captcha", async () => {
    const connection = createConnection()
    globalThis.fetch = (async () =>
      jsonResponse({
        code: 3007,
        msg: "captcha invalid",
      })) as unknown as typeof fetch

    const error = await claimZcodePlan(connection, {
      planId: "weekend",
      verifyParam: "bad",
    }).catch((caught: unknown) => caught)

    expect((error as ZcodeClaimError).code).toBe(3007)
    expect((error as Error).message).toContain("captcha")
  })

  test("an expired session JWT is rejected before any request", async () => {
    const connection = createConnection()
    connection.credentials[0]!.context = {
      zcodeJwt: jwt(Math.floor(Date.now() / 1000) - 60),
    }
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch

    await expect(fetchZcodeClaimPlans(connection)).rejects.toThrow(
      /sign-in has expired/i,
    )
    expect(calls).toBe(0)
  })

  test("uses the connection proxy when one is configured", async () => {
    const connection = createConnection()
    connection.metadata = { proxyUrl: "http://127.0.0.1:7890" }
    let proxy: unknown
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit & { proxy?: string },
    ) => {
      proxy = init?.proxy
      return jsonResponse({ code: 0, data: { plans: [] } })
    }) as unknown as typeof fetch

    expect(getConnectionProxyUrl(connection)).toBe("http://127.0.0.1:7890")
    await fetchZcodeClaimPlans(connection)
    expect(proxy).toBe("http://127.0.0.1:7890")
  })
})

describe("zcode claim state", () => {
  test("round-trips plans, holds and the last claim through metadata", () => {
    const connection = createConnection()
    writeZcodeClaimState(connection, {
      checkedAt: 1,
      plans: [
        {
          planId: "weekend",
          name: "Weekend egg",
          description: "",
          priority: 5,
          grants: [{ name: "GLM-5.3", units: 3_000_000, period: "one_time" }],
        },
      ],
      holds: { weekend: 1_700_000_000_000 },
      lastClaim: { planId: "other", planName: "Other", at: 2 },
    })

    const state = readZcodeClaimState(connection)
    expect(state.plans?.[0]?.grants[0]?.units).toBe(3_000_000)
    expect(state.holds?.weekend).toBe(1_700_000_000_000)
    expect(state.lastClaim?.planName).toBe("Other")
  })

  test("only enabled zcode connections with a live JWT are candidates", () => {
    expect(isZcodeClaimCandidate(createConnection())).toBe(true)

    const disabled = createConnection({ enabled: false })
    expect(isZcodeClaimCandidate(disabled)).toBe(false)

    const expired = createConnection()
    expired.credentials[0]!.context = {
      zcodeJwt: jwt(Math.floor(Date.now() / 1000) - 60),
    }
    expect(isZcodeClaimCandidate(expired)).toBe(false)

    const apiKeyOnly = createConnection()
    apiKeyOnly.credentials[0]!.context = {}
    expect(isZcodeClaimCandidate(apiKeyOnly)).toBe(false)

    const other = createConnection({ protocol: "anthropic-compatible" })
    expect(isZcodeClaimCandidate(other)).toBe(false)
  })
})

describe("zcode auto-claim round", () => {
  test("a 1005 hold delays the next claim until the upstream recovery time", async () => {
    initializeSystemConfig({
      save: () => undefined,
      onChange: () => undefined,
    })
    const originalDir = PATHS.APP_DIR
    const testDir = fs.mkdtempSync(path.join(originalDir, "..", "zcode-round-"))
    const originalSettings = { ...getSystemSettings() }
    redirectPathsToDir(testDir)
    __resetProviderConnectionsForTest()
    upsertProviderConnection(createConnection())
    updateSystemConfig({
      ...originalSettings,
      zcodeAutoClaim: true,
      debugMinutes: 15,
    })
    __setZcodeVerifyParamForTest("verify-token")

    const endsAt = Math.floor(Date.now() / 1000) + 600
    let previewCalls = 0
    let claimCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      // The claim round also resolves the client version from the release
      // manifest; that call is neither a preview nor a claim.
      if (url.includes("/api/v1/releases/electron/manifest")) {
        return new Response(`version: ${ZCODE_APP_VERSION}\n`, { status: 200 })
      }
      if (url.includes("/billing/preview")) {
        previewCalls++
        return jsonResponse({
          code: 0,
          data: {
            plans: [
              {
                plan_id: "weekend",
                name: "Weekend egg",
                priority: 3,
                entitlements: [
                  {
                    meter: "model_usage",
                    unit_type: "token",
                    show_name: "GLM-5.3",
                    grant_units: 1_000_000,
                  },
                ],
              },
            ],
          },
        })
      }
      claimCalls++
      return jsonResponse({
        code: 1005,
        msg: "quota exhausted",
        data: { plan: { ends_at: endsAt } },
      })
    }) as unknown as typeof fetch

    try {
      await runZcodeClaimRound()
      expect(previewCalls).toBe(1)
      expect(claimCalls).toBe(1)

      const afterFirst = readZcodeClaimState(
        // read through the shared state object the round mutated
        (await import("~/lib/provider-connections")).getProviderConnection(
          "zcode-claim-test",
        )!,
      )
      expect(afterFirst.holds?.weekend).toBe(endsAt * 1000)
      expect(afterFirst.nextAttemptAt).toBeLessThanOrEqual(endsAt * 1000)

      // Still inside the hold: the whole account is skipped (no preview, no claim).
      await runZcodeClaimRound(endsAt * 1000 - 60_000)
      expect(previewCalls).toBe(1)
      expect(claimCalls).toBe(1)

      // Once the hold has expired the round retries.
      await runZcodeClaimRound(endsAt * 1000 + 1_000)
      expect(previewCalls).toBe(2)
      expect(claimCalls).toBe(2)
    } finally {
      updateSystemConfig({ ...originalSettings, debugMinutes: 15 })
      redirectPathsToDir(originalDir)
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })
})
