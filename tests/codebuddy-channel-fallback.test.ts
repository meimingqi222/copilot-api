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
} from "~/lib/provider-connections"
import { resetModelCooldownsForTest } from "~/lib/model-cooldown"
import { HTTPError } from "~/lib/error"
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
  __resetProviderConnectionsForTest()
})

describe("CodeBuddy model discovery", () => {
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

  test("CN discovery stays on the existing config endpoint", async () => {
    const credential = makeCredential()
    const connection = makeConnection(credential)
    connection.baseUrl = "https://copilot.tencent.com/v2"
    connection.headers = { "X-Domain": "www.codebuddy.cn" }
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        expect(String(input)).toBe("https://copilot.tencent.com/v3/config")
        return Response.json({
          code: 0,
          data: { models: [{ id: "cn-model" }] },
        })
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    expect(
      (
        await codebuddyNativeAdapter.discoverModels!({ connection, credential })
      ).map((m) => m.publicId),
    ).toEqual(["cn-model"])
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
