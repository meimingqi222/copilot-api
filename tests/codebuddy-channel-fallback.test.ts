import { afterEach, describe, expect, mock, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

import {
  __resetProviderConnectionsForTest,
  classifyUpstreamError,
  isCodebuddyChannelCheck,
  setConnectionQuotaState,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import {
  buildRouteTargets,
  clearRestRegistryForTest,
  recordRest,
} from "~/lib/route-target"
import {
  checkRateLimit,
  getRemainingCooldownSeconds,
  reportUpstreamRateLimitMs,
  resetAdaptiveRateLimiterForTest,
} from "~/lib/rate-limit"
import { resetModelCooldownsForTest } from "~/lib/model-cooldown"
import { refreshCodebuddyQuota } from "~/services/codebuddy/quota"
import { waitForCredentialLease } from "~/services/dispatch/concurrency"
import { executeWithFailover } from "~/services/dispatch/failover"
import { HTTPError } from "~/lib/error"
import { initializeProtocolAdapters } from "~/services/protocols"
import {
  codebuddyCnProviderRuntime,
  codebuddyProviderRuntime,
} from "~/services/providers/codebuddy"
import {
  codebuddyNativeAdapter,
  ensureCodebuddyFirstSystemMessage,
  resolveCodebuddyChatUrls,
} from "~/services/protocols/codebuddy-native"

const originalFetch = globalThis.fetch

function encodeJwtPart(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function jwt(exp: number, sub = "user-1"): string {
  return `${encodeJwtPart({ alg: "none" })}.${encodeJwtPart({ exp, sub })}.signature`
}

function makeCredential(overrides: Partial<ApiCredential> = {}): ApiCredential {
  return {
    id: "codebuddy-credential",
    authMode: "bearer",
    value: jwt(Math.floor(Date.now() / 1000) + 3600),
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
    refresherType: "codebuddy-token",
    context: { accountId: "codebuddy-connection" },
    ...overrides,
  }
}

function makeConnection(credential: ApiCredential): ProviderConnection {
  return {
    id: "codebuddy-connection",
    name: "CodeBuddy",
    protocol: "codebuddy-native",
    baseUrl: "https://www.workbuddy.ai/v2",
    headers: { "X-Domain": "www.workbuddy.ai" },
    enabled: true,
    priority: 0,
    credentials: [credential],
    createdAt: Date.now(),
    metadata: { provider: "codebuddy" },
  }
}

function sseResponse(): Response {
  return new Response(
    [
      'data: {"id":"cb-1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
      "",
      'data: {"id":"cb-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

/** 用户实测的新形态：msg 是首条非 system，displayTips 是渠道校验话术。 */
function hybridChannelBody(): string {
  return JSON.stringify({
    code: 11128,
    msg: "first message is not system prompt",
    displayTips: {
      en: "This call failed channel verification, possibly because it was not sent from an official client. Please resend from the official client.",
      zh: "这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。",
    },
  })
}

function contentBlockedBody(): string {
  return JSON.stringify({
    code: 11128,
    msg: "blocked by security policy",
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  resetModelCooldownsForTest()
  clearRestRegistryForTest()
  resetAdaptiveRateLimiterForTest()
  __resetProviderConnectionsForTest()
})

describe("CodeBuddy model discovery", () => {
  test("zero credits retain discovered free models, not paid or unknown models", async () => {
    const credential = makeCredential()
    const connection = makeConnection(credential)
    const now = Date.now()
    const promotion = (id: string, schedule: Record<string, unknown>) => ({
      kind: "discount",
      modelIds: [id],
      schedule,
      discount: { discountedCredits: "0.00x" },
    })
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        if (String(input).endsWith("/chat/completions")) return sseResponse()
        if (String(input).endsWith("get-user-resource"))
          return Response.json({
            code: 0,
            data: {
              Response: {
                Data: {
                  Accounts: [
                    {
                      CycleCapacitySize: 100,
                      CycleCapacityRemain: 0,
                      CycleCapacityUsed: 100,
                    },
                  ],
                },
              },
            },
          })
        return Response.json({
          code: 0,
          data:
            String(input).endsWith("/v3/config") ?
              {
                models: [
                  { id: "free", name: "Shared name", credits: "x0.00" },
                  { id: "free-sg", name: "Shared name", credits: "x0.03" },
                  { id: "numeric-free", credits: 0 },
                  { id: "units-free", credits: "x0.00 credits" },
                  { id: "unknown" },
                  { id: "blank", credits: "" },
                  { id: "invalid", credits: "free" },
                  { id: "null", credits: null },
                  { id: "promo", credits: "x0.5" },
                  { id: "expired", credits: "x0.00" },
                  { id: "night", credits: "x0.00" },
                ],
                modelPromotions: [
                  promotion("promo", {
                    validUntil: new Date(now + 60_000).toISOString(),
                  }),
                  promotion("expired", {
                    validUntil: new Date(now - 60_000).toISOString(),
                  }),
                  promotion("night", {
                    daily: [{ start: "00:00", end: "08:00" }],
                  }),
                ],
              }
            : ["account-only"],
        })
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    connection.models = await codebuddyNativeAdapter.discoverModels!({
      connection,
      credential,
    })
    connection.models.find((m) => m.upstreamId === "free")!.publicId =
      "renamed-free"
    upsertProviderConnection(connection)
    await refreshCodebuddyQuota(connection)
    expect(credential.status).toBe("quota_exhausted")
    // A paid request's balance refusal must not prevent free-model routing.
    recordRest({
      credentialId: credential.id,
      reason: "credit",
      by: "credit",
      untilMs: now + 60_000,
    })
    const targets = buildRouteTargets({
      connectionId: connection.id,
      endpoint: "messages",
    })
    expect(targets.map((t) => t.upstreamModelId)).toEqual([
      "free",
      "numeric-free",
      "units-free",
      "promo",
    ])
    expect(targets[0].publicModelId).toBe("renamed-free")
    expect(targets[0].isTranslated).toBe(true)
    expect(getRemainingCooldownSeconds(connection.id)).toBe(0)
    await checkRateLimit(connection.id, AbortSignal.timeout(200))
    // Queue rechecks must use the same model-scoped availability contract.
    const granted = await waitForCredentialLease(
      [targets[0]],
      AbortSignal.timeout(200),
    )
    granted.lease.release()
    const payload: ChatCompletionsPayload = {
      model: "renamed-free",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }
    const result = await executeWithFailover({
      payload,
      admission: { target: targets[0], connection, credential },
      routeKind: "chat",
      signal: AbortSignal.timeout(200),
      execute: (_adapter, target, current) =>
        codebuddyNativeAdapter.createChatCompletions!({
          target,
          connection: current.connection,
          credential: current.credential,
          payload,
        }),
    })
    expect(
      "choices" in result.response
        && result.response.choices[0].message.content,
    ).toBe("ok")
    expect(credential.status).toBe("quota_exhausted")

    const promo = connection.models.find((m) => m.publicId === "promo")!
    promo.metadata!.codebuddyPromotions = [
      promotion("promo", { validUntil: new Date(now - 1).toISOString() }),
    ]
    expect(
      buildRouteTargets({
        connectionId: connection.id,
        publicModelId: "promo",
      }),
    ).toEqual([])

    // Balance restoration re-enables paid/unknown models, without changing prices.
    setConnectionQuotaState(connection, "available")
    clearRestRegistryForTest()
    expect(
      buildRouteTargets({
        connectionId: connection.id,
        publicModelId: "free-sg",
      }),
    ).toHaveLength(1)
    expect(
      buildRouteTargets({
        connectionId: connection.id,
        publicModelId: "account-only",
      }),
    ).toHaveLength(1)
  })

  test("zero-credit exemptions never bypass auth, rate, verification or model rests", async () => {
    const credential = makeCredential()
    const connection = makeConnection(credential)
    connection.models = [
      {
        publicId: "free",
        upstreamId: "free",
        endpoints: ["chat"],
        enabled: true,
        metadata: { codebuddyCredits: "x0.00" },
      },
    ]
    upsertProviderConnection(connection)
    setConnectionQuotaState(connection, "exhausted")
    const targets = () =>
      buildRouteTargets({ connectionId: connection.id, publicModelId: "free" })
    expect(targets()).toHaveLength(1)
    credential.enabled = false
    expect(targets()).toEqual([])
    credential.enabled = true
    credential.status = "auth_error"
    expect(targets()).toEqual([])
    credential.status = "quota_exhausted"
    for (const reason of ["verify", "rate", "quota"] as const) {
      recordRest({
        credentialId: credential.id,
        reason,
        by: "cooldown",
        untilMs: Date.now() + 60_000,
      })
      expect(targets()).toEqual([])
      clearRestRegistryForTest()
    }
    // The vendor can still refuse a nominally free model; rest that model.
    await expect(
      executeWithFailover({
        payload: { model: "free" },
        admission: { target: targets()[0], connection, credential },
        routeKind: "chat",
        execute: async () => {
          throw new HTTPError(
            "No active package",
            new Response(null, { status: 429 }),
            '{"error":{"message":"Credits exhausted"}}',
          )
        },
      }),
    ).rejects.toThrow("No active package")
    expect(targets()).toEqual([])
    clearRestRegistryForTest()
    await reportUpstreamRateLimitMs(connection.id, 1000)
    expect(targets()).toEqual([])
  })

  test.each([undefined, "custom-client"])(
    "international discovery uses WorkBuddy identity unless overridden (%s)",
    async (customUa) => {
      const credential = makeCredential()
      const connection = makeConnection(credential)
      if (customUa) connection.headers!["uSeR-aGeNt"] = customUa
      globalThis.fetch = Object.assign(
        async (_input: string | URL | Request, init?: RequestInit) => {
          const ua = new Headers(init?.headers).get("user-agent")
          const supported =
            ua
            === (customUa ?? "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1")
          return Response.json({
            code: 0,
            data: {
              models:
                supported ?
                  [{ id: "step-5-preview", name: "Step-5-Preview" }]
                : [],
            },
          })
        },
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch
      const models = await codebuddyNativeAdapter.discoverModels!({
        connection,
        credential,
      })
      expect(models.map((m) => m.publicId)).toEqual(["step-5-preview"])
    },
  )

  test.each([false, true])(
    "merges account-only IDs with config metadata (string array: %s)",
    async (strings) => {
      const credential = makeCredential()
      const connection = makeConnection(credential)
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request) => {
          const config = String(input).endsWith("/v3/config")
          return Response.json({
            code: 0,
            data:
              config ?
                {
                  models: [
                    { id: "shared", name: "Config name" },
                    { id: "config-only" },
                    { id: "default" },
                    { id: "disabled", disabled: true },
                  ],
                }
              : strings ? ["shared", "account-only", "account-only"]
              : {
                  models: [
                    { id: "shared", name: "Account name" },
                    { id: "account-only" },
                  ],
                },
          })
        },
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch
      const models = await codebuddyNativeAdapter.discoverModels!({
        connection,
        credential,
      })
      expect(models.map((m) => m.publicId)).toEqual([
        "shared",
        "config-only",
        "account-only",
      ])
      expect(models[0]?.name).toBe("Config name")
      expect(models[2]?.upstreamId).toBe("account-only")
    },
  )

  test.each(["http", "business", "network"])(
    "uses console alternate after %s failure, even with null config models",
    async (failure) => {
      const credential = makeCredential()
      const connection = makeConnection(credential)
      connection.proxyUrl = "http://proxy.example.invalid:8080"
      const controller = new AbortController()
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          expect((init as RequestInit & { proxy?: string }).proxy).toBe(
            connection.proxyUrl,
          )
          expect(init?.signal).toBe(controller.signal)
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${credential.value}`,
          )
          const url = String(input)
          if (url.endsWith("/v3/config"))
            return Response.json({ code: 0, data: { models: null } })
          if (url.includes("/v2/enterprises")) {
            if (failure === "network") throw new Error("network unavailable")
            return Response.json(
              { code: 11128 },
              { status: failure === "http" ? 403 : 200 },
            )
          }
          return Response.json({ code: 0, data: ["account-only"] })
        },
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch
      const models = await codebuddyNativeAdapter.discoverModels!({
        connection,
        credential,
        signal: controller.signal,
      })
      expect(models.map((m) => m.publicId)).toEqual(["account-only"])
      expect(credential.status).toBe("ready")
    },
  )

  test.each(["config", "account"])(
    "keeps the other source when %s fails",
    async (failed) => {
      const credential = makeCredential()
      const connection = makeConnection(credential)
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request) => {
          const config = String(input).endsWith("/v3/config")
          return (failed === "config") === config ?
              new Response("unavailable", { status: 503 })
            : Response.json({
                code: 0,
                data: config ? { models: [{ id: "survivor" }] } : ["survivor"],
              })
        },
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch
      expect(
        (
          await codebuddyNativeAdapter.discoverModels!({
            connection,
            credential,
          })
        ).map((m) => m.publicId),
      ).toEqual(["survivor"])
      expect(credential.status).toBe("ready")
    },
  )

  test("all sources failing rejects without disabling the credential", async () => {
    const credential = makeCredential()
    const connection = makeConnection(credential)
    globalThis.fetch = Object.assign(
      async () => new Response("forbidden", { status: 403 }),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    await expect(
      codebuddyNativeAdapter.discoverModels!({ connection, credential }),
    ).rejects.toBeInstanceOf(HTTPError)
    expect(credential.status).toBe("ready")
  })

  test("CN merges config with CLI account models and filters non-chat entries", async () => {
    const credential = makeCredential()
    const connection = makeConnection(credential)
    connection.baseUrl = "https://copilot.tencent.com/v2"
    connection.headers = { "X-Domain": "www.codebuddy.cn" }
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("user-agent")).toBe(
          "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1",
        )
        if (String(input).endsWith("/v3/config"))
          return Response.json({
            code: 0,
            data: {
              models: [
                { id: "cn-model", name: "Config name" },
                { id: "config-only", maxOutputTokens: 257 },
                { id: "nes-config" },
                { id: "tiny-config", maxOutputTokens: 256 },
                { id: "image-config", tags: ["text-to-image"] },
              ],
            },
          })
        expect(String(input)).toBe(
          "https://copilot.tencent.com/console/enterprises/personal/models",
        )
        return Response.json({
          code: 0,
          data: {
            models: [
              { id: "cn-model", name: "Account name" },
              { id: "account-only" },
              { id: "not-cli" },
              { id: "disabled", disabled: true },
              { id: "completion-hidden" },
              { id: "codewise-hidden" },
            ],
            agents: [
              {
                name: "cli",
                models: [
                  "cn-model",
                  "account-only",
                  "disabled",
                  "completion-hidden",
                  "codewise-hidden",
                  "missing",
                ],
              },
            ],
          },
        })
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    initializeProtocolAdapters()
    const models = await codebuddyCnProviderRuntime.refreshModels(connection)
    expect(models.map((m) => m.publicId)).toEqual([
      "cn-model",
      "config-only",
      "account-only",
    ])
    expect(models[0]?.name).toBe("Config name")
  })

  test.each(["empty-cli", "no-cli", "string-list", "failed"])(
    "CN has no static membership fallback (%s)",
    async (shape) => {
      const credential = makeCredential()
      const connection = makeConnection(credential)
      connection.baseUrl = "https://copilot.tencent.com/v2"
      globalThis.fetch = Object.assign(
        async () =>
          shape === "failed" ?
            new Response("unavailable", { status: 503 })
          : Response.json({
              code: 0,
              data:
                shape === "string-list" ?
                  ["dynamic-only"]
                : {
                    models: [{ id: "dynamic-only", maxOutputTokens: 0 }],
                    ...(shape === "empty-cli" ?
                      { agents: [{ name: "cli", models: [] }] }
                    : {}),
                  },
            }),
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch
      initializeProtocolAdapters()
      expect(
        (await codebuddyCnProviderRuntime.refreshModels(connection)).map(
          (m) => m.publicId,
        ),
      ).toEqual(shape === "failed" ? [] : ["dynamic-only"])
      expect(
        codebuddyCnProviderRuntime.getFallbackModels?.(connection),
      ).toEqual([])
    },
  )

  test("international runtime retains its static supplement", async () => {
    const credential = makeCredential()
    const connection = makeConnection(credential)
    globalThis.fetch = Object.assign(
      async () => Response.json({ code: 0, data: ["dynamic-only"] }),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    initializeProtocolAdapters()
    const ids = (await codebuddyProviderRuntime.refreshModels(connection)).map(
      (m) => m.publicId,
    )
    expect(ids).toContain("dynamic-only")
    expect(ids).toContain("gpt-5.6-sol")
  })
})

describe("isCodebuddyChannelCheck", () => {
  test("hybrid body (first-message msg + channel tips) is a channel check", () => {
    expect(isCodebuddyChannelCheck(hybridChannelBody())).toBe(true)
  })

  test("hyphenated code with Chinese wording is a channel check", () => {
    expect(
      isCodebuddyChannelCheck(
        JSON.stringify({
          code: "11-128",
          msg: "request illegal",
          displayTips: { zh: "这次调用没通过渠道校验" },
        }),
      ),
    ).toBe(true)
  })

  test("content block with same code but no channel wording is not", () => {
    expect(isCodebuddyChannelCheck(contentBlockedBody())).toBe(false)
  })

  test("other codes are not channel checks", () => {
    expect(
      isCodebuddyChannelCheck(
        JSON.stringify({ code: 11140, msg: "request illegal" }),
      ),
    ).toBe(false)
    expect(isCodebuddyChannelCheck("")).toBe(false)
  })
})

describe("codebuddy channel classification", () => {
  test("hyphenated 11-128 on 400 stays client_error", () => {
    const body = JSON.stringify({
      code: "11-128",
      msg: "first message is not system prompt",
    })
    expect(
      classifyUpstreamError({ status: 400, retryAfterHeader: null, body }).kind,
    ).toBe("client_error")
  })

  test("hybrid channel body on 403 stays client_error, never auth_error", () => {
    expect(
      classifyUpstreamError({
        status: 403,
        retryAfterHeader: null,
        body: hybridChannelBody(),
      }).kind,
    ).toBe("client_error")
  })
})

describe("resolveCodebuddyChatUrls", () => {
  test("v2 first, console fallback", () => {
    const credential = makeCredential()
    expect(resolveCodebuddyChatUrls(makeConnection(credential))).toEqual([
      "https://www.workbuddy.ai/v2/chat/completions",
      "https://www.workbuddy.ai/console/chat/completions",
    ])
  })

  test("base without /v2 gets the same pair", () => {
    const credential = makeCredential()
    const connection = makeConnection(credential)
    connection.baseUrl = "https://www.workbuddy.ai"
    expect(resolveCodebuddyChatUrls(connection)).toEqual([
      "https://www.workbuddy.ai/v2/chat/completions",
      "https://www.workbuddy.ai/console/chat/completions",
    ])
  })

  test("malformed base falls back to a single path, never throws", () => {
    const credential = makeCredential()
    const connection = makeConnection(credential)
    connection.baseUrl = "http://[::1"
    expect(resolveCodebuddyChatUrls(connection)).toEqual([
      "http://[::1/v2/chat/completions",
    ])
  })
})

describe("ensureCodebuddyFirstSystemMessage", () => {
  test("prepends a neutral system when missing", () => {
    const messages = [{ role: "user", content: "hi" }] as unknown as Array<{
      role: string
      content: string
    }>
    ensureCodebuddyFirstSystemMessage(
      messages as unknown as Parameters<
        typeof ensureCodebuddyFirstSystemMessage
      >[0],
    )
    expect(messages[0]?.role).toBe("system")
    expect(messages).toHaveLength(2)
  })

  test("keeps an existing system untouched", () => {
    const messages = [
      { role: "system", content: "orig" },
      { role: "user", content: "hi" },
    ] as unknown as Array<{ role: string; content: string }>
    ensureCodebuddyFirstSystemMessage(
      messages as unknown as Parameters<
        typeof ensureCodebuddyFirstSystemMessage
      >[0],
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]?.content).toBe("orig")
  })
})

describe("codebuddy /console fallback", () => {
  test("channel check on /v2 retries /console and succeeds", async () => {
    const seen: string[] = []
    let upstreamBody: Record<string, unknown> | undefined
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      seen.push(String(url))
      if (seen.length === 1) {
        return Promise.resolve(
          new Response(hybridChannelBody(), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        )
      }
      upstreamBody = JSON.parse(init.body as string) as Record<string, unknown>
      return Promise.resolve(sseResponse())
    }) as unknown as typeof fetch

    const credential = makeCredential()
    const result = await codebuddyNativeAdapter.createChatCompletions?.({
      target: { upstreamModelId: "gpt-5.6-sol" } as Parameters<
        NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
      >[0]["target"],
      connection: makeConnection(credential),
      credential,
      payload: {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
      } as ChatCompletionsPayload,
    })

    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain("/v2/chat/completions")
    expect(seen[1]).toContain("/console/chat/completions")
    expect(result?.credentialId).toBe(credential.id)
    // 首条 system 在换路后的请求里同样保障
    const msgs = upstreamBody?.messages as Array<{ role: string }>
    expect(msgs[0]?.role).toBe("system")
    // 渠道校验永不禁用 credential
    expect(credential.status).toBe("ready")
    expect(credential.cooldownUntil).toBeUndefined()
  })

  test("content block does not trigger a path retry", async () => {
    let calls = 0
    globalThis.fetch = mock(() => {
      calls++
      return Promise.resolve(
        new Response(contentBlockedBody(), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const credential = makeCredential()
    let thrown: unknown
    try {
      await codebuddyNativeAdapter.createChatCompletions?.({
        target: { upstreamModelId: "gpt-5.6-sol" } as Parameters<
          NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
        >[0]["target"],
        connection: makeConnection(credential),
        credential,
        payload: {
          model: "gpt-5.6-sol",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "hi" },
          ],
        } as ChatCompletionsPayload,
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
    expect(credential.status).toBe("ready")
  })

  test("both paths blocked surfaces client_error without disabling", async () => {
    let calls = 0
    globalThis.fetch = mock(() => {
      calls++
      return Promise.resolve(
        new Response(hybridChannelBody(), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const credential = makeCredential()
    let thrown: unknown
    try {
      await codebuddyNativeAdapter.createChatCompletions?.({
        target: { upstreamModelId: "gpt-5.6-sol" } as Parameters<
          NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
        >[0]["target"],
        connection: makeConnection(credential),
        credential,
        payload: {
          model: "gpt-5.6-sol",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "hi" },
          ],
        } as ChatCompletionsPayload,
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(HTTPError)
    expect(calls).toBe(2)
    expect(credential.status).toBe("ready")
    expect(credential.cooldownUntil).toBeUndefined()
  })

  test("user-first payload gains a system head upstream", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      upstreamBody = JSON.parse(init.body as string) as Record<string, unknown>
      return Promise.resolve(sseResponse())
    }) as unknown as typeof fetch

    const credential = makeCredential()
    await codebuddyNativeAdapter.createChatCompletions?.({
      target: { upstreamModelId: "gpt-5.6-sol" } as Parameters<
        NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
      >[0]["target"],
      connection: makeConnection(credential),
      credential,
      payload: {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "ping" }],
      } as ChatCompletionsPayload,
    })

    const msgs = upstreamBody?.messages as Array<{
      role: string
      content: string
    }>
    expect(msgs[0]?.role).toBe("system")
    expect(msgs[1]?.role).toBe("user")
  })
})
