import { afterEach, describe, expect, mock, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import {
  cancelAllCodebuddyRefreshTimers,
  codebuddyNeedsRefresh,
  ensureCodebuddyAccessToken,
} from "~/services/codebuddy/token-refresh"
import { HTTPError } from "~/lib/error"
import {
  isModelCoolingDown,
  resetModelCooldownsForTest,
} from "~/lib/model-cooldown"
import { codebuddyNativeAdapter } from "~/services/protocols/codebuddy-native"

const originalFetch = globalThis.fetch

function encodeJwtPart(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

afterEach(() => {
  globalThis.fetch = originalFetch
  cancelAllCodebuddyRefreshTimers()
  resetModelCooldownsForTest()
  __resetProviderConnectionsForTest()
})

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

describe("CodeBuddy request handling", () => {
  test("normalizes the upstream copy without mutating the failover payload", async () => {
    let upstreamBody: ChatCompletionsPayload | undefined
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      upstreamBody = JSON.parse(init.body as string) as ChatCompletionsPayload
      return Promise.resolve(sseResponse())
    }) as unknown as typeof fetch

    const credential = makeCredential()
    const connection = makeConnection(credential)
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.6-sol",
      messages: [
        {
          role: "developer",
          content: "keep x-anthropic-billing-header out of logs",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "inspect",
            description: "find x-anthropic-billing-header",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    }
    const original = structuredClone(payload)
    const target = {
      upstreamModelId: "gpt-5.6-sol",
    } as Parameters<
      NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
    >[0]["target"]

    await codebuddyNativeAdapter.createChatCompletions?.({
      target,
      connection,
      credential,
      payload,
    })

    expect(payload).toEqual(original)
    expect(upstreamBody?.messages[0]?.role).toBe("system")
    expect(upstreamBody?.messages[0]?.content).toBe(
      "keep x-anthropic-billing-hdr out of logs",
    )
    expect(upstreamBody?.tools?.[0]?.function.description).toBe(
      "find x-anthropic-billing-hdr",
    )
  })

  test("normalizes tool_choice object form to upstream string form", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      upstreamBody = JSON.parse(init.body as string) as Record<string, unknown>
      return Promise.resolve(sseResponse())
    }) as unknown as typeof fetch

    const credential = makeCredential()
    const target = {
      upstreamModelId: "gpt-5.6-sol",
    } as Parameters<
      NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
    >[0]["target"]

    await codebuddyNativeAdapter.createChatCompletions?.({
      target,
      connection: makeConnection(credential),
      credential,
      payload: {
        model: "gpt-5.6-sol",
        messages: [],
        tool_choice: { type: "function", function: { name: "inspect" } },
        tools: [
          {
            type: "function",
            function: { name: "inspect", parameters: {} },
          },
        ],
      },
    })
    expect(upstreamBody?.tool_choice).toBe("inspect")
    expect(upstreamBody?.tools).toHaveLength(1)

    await codebuddyNativeAdapter.createChatCompletions?.({
      target,
      connection: makeConnection(credential),
      credential,
      payload: {
        model: "gpt-5.6-sol",
        messages: [],
        tool_choice: { type: "auto" },
      } as unknown as ChatCompletionsPayload,
    })
    expect(upstreamBody?.tool_choice).toBe("auto")

    await codebuddyNativeAdapter.createChatCompletions?.({
      target,
      connection: makeConnection(credential),
      credential,
      payload: {
        model: "gpt-5.6-sol",
        messages: [],
        tool_choice: "none",
        tools: [
          {
            type: "function",
            function: { name: "inspect", parameters: {} },
          },
        ],
      },
    })
    expect(upstreamBody?.tool_choice).toBeUndefined()
    expect(upstreamBody?.tools).toBeUndefined()
  })

  test("translates max_completion_tokens and injects stream_options", async () => {
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
        messages: [],
        max_completion_tokens: 4096,
      } as ChatCompletionsPayload,
    })

    expect(upstreamBody?.max_completion_tokens).toBeUndefined()
    expect(upstreamBody?.max_tokens).toBe(4096)
    expect(upstreamBody?.stream_options).toEqual({ include_usage: true })
  })

  test("normalizes string image_url parts to object form", async () => {
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
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: "data:image/png;base64,xx" },
            ],
          },
        ],
      } as unknown as ChatCompletionsPayload,
    })

    const msgs = upstreamBody?.messages as Array<{
      content: Array<{ image_url: unknown }>
    }>
    expect(msgs[0]?.content[0]?.image_url).toEqual({
      url: "data:image/png;base64,xx",
    })
  })

  test("repacks interleaved tool results and drops orphan tool_calls", async () => {
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
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c00",
                type: "function",
                function: { name: "a", arguments: "{}" },
              },
              {
                id: "c01",
                type: "function",
                function: { name: "b", arguments: "{}" },
              },
              {
                id: "c02",
                type: "function",
                function: { name: "c", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "c00", content: "r0" },
          { role: "system", content: "image_resize_notice" },
          { role: "tool", tool_call_id: "c01", content: "r1" },
          { role: "tool", tool_call_id: "orphan", content: "rx" },
        ],
      },
    })

    const msgs = upstreamBody?.messages as Array<{
      role: string
      tool_call_id?: string
      tool_calls?: Array<{ id: string }>
    }>
    // c02 无结果 → 从 tool_calls 裁剪；orphan 结果整条删除；
    // system 插入消息挪到结果组之后。
    expect(msgs.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "system",
    ])
    expect(msgs[0]?.tool_calls?.map((tc) => tc.id)).toEqual(["c00", "c01"])
    expect(msgs[1]?.tool_call_id).toBe("c00")
    expect(msgs[2]?.tool_call_id).toBe("c01")
  })

  test("injects thinking and backfills reasoning for deepseek models only", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      upstreamBody = JSON.parse(init.body as string) as Record<string, unknown>
      return Promise.resolve(sseResponse())
    }) as unknown as typeof fetch

    const credential = makeCredential()
    const target = { upstreamModelId: "deepseek-v4-flash" } as Parameters<
      NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
    >[0]["target"]

    await codebuddyNativeAdapter.createChatCompletions?.({
      target,
      connection: makeConnection(credential),
      credential,
      payload: {
        model: "deepseek-v4-flash",
        messages: [{ role: "assistant", content: "hi" }],
      },
    })
    expect(upstreamBody?.thinking).toEqual({ type: "enabled" })
    expect(upstreamBody?.reasoning_effort).toBe("high")
    const msgs = upstreamBody?.messages as Array<{
      reasoning?: string
      reasoning_content?: string
    }>
    expect(msgs[0]?.reasoning_content).toBe("")
    expect(msgs[0]?.reasoning).toBe(" ")

    // 非 deepseek 模型零改动
    await codebuddyNativeAdapter.createChatCompletions?.({
      target: { upstreamModelId: "gpt-5.6-sol" } as Parameters<
        NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
      >[0]["target"],
      connection: makeConnection(credential),
      credential,
      payload: {
        model: "gpt-5.6-sol",
        messages: [{ role: "assistant", content: "hi" }],
      },
    })
    expect(upstreamBody?.thinking).toBeUndefined()
    expect(upstreamBody?.reasoning_effort).toBeUndefined()
  })

  test("sends realm headers and stable account device ids", async () => {
    let upstreamHeaders: Headers | undefined
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      upstreamHeaders = new Headers(init.headers)
      return Promise.resolve(sseResponse())
    }) as unknown as typeof fetch

    const credential = makeCredential()
    await codebuddyNativeAdapter.createChatCompletions?.({
      target: { upstreamModelId: "gpt-5.6-sol" } as Parameters<
        NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
      >[0]["target"],
      connection: makeConnection(credential),
      credential,
      payload: { model: "gpt-5.6-sol", messages: [] },
    })

    expect(upstreamHeaders?.get("origin")).toBe("https://www.workbuddy.ai")
    expect(upstreamHeaders?.get("referer")).toBe("https://www.workbuddy.ai/")
    expect(upstreamHeaders?.get("accept-language")).toBe("en-US")
    expect(upstreamHeaders?.get("x-no-enterprise-id")).toBe("1")
    expect(upstreamHeaders?.get("x-machine-id")).toMatch(/^[0-9a-f]{36}$/)
    expect(upstreamHeaders?.get("x-session-id")).toMatch(/^[0-9a-f]{36}$/)
    expect(upstreamHeaders?.get("x-machine-id")).not.toBe(
      upstreamHeaders?.get("x-session-id"),
    )
  })

  test("SSE first-frame 6004 surfaces as rate-limit error with Retry-After", async () => {
    // 6004 超出合法 HTTP status 范围（200-599），detectOpenAIStreamError
    // 构造 Response 时越界会 RangeError——此前被吞导致错误帧当数据透传。
    globalThis.fetch = mock((_url: string, _init: RequestInit) => {
      return Promise.resolve(
        new Response(
          'data: {"error":{"message":"您的使用量已超出频率限制","code":"6004"}}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      )
    }) as unknown as typeof fetch

    const credential = makeCredential()
    const connection = makeConnection(credential)
    let thrown: unknown
    try {
      await codebuddyNativeAdapter.createChatCompletions?.({
        target: { upstreamModelId: "deepseek-v4-flash" } as Parameters<
          NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
        >[0]["target"],
        connection,
        credential,
        payload: { model: "deepseek-v4-flash", messages: [] },
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(HTTPError)
    const httpError = thrown as HTTPError
    // 越界码回落为 500，业务码 6004 保留在 responseBody 里。
    expect(httpError.response.status).toBe(500)
    expect(httpError.response.headers.get("retry-after")).toBeTruthy()
    expect(httpError.responseBody).toContain('"6004"')
    // 模型级冷却落库（failover 路径也会补录，幂等）。
    expect(isModelCoolingDown(credential.id, "deepseek-v4-flash")).toBe(true)
    // 账号本身不被冷却
    expect(credential.cooldownUntil).toBeUndefined()
  })

  test("applies custom headers case-insensitively without combining duplicates", async () => {
    let upstreamHeaders: Headers | undefined
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      upstreamHeaders = new Headers(init.headers)
      return Promise.resolve(sseResponse())
    }) as unknown as typeof fetch

    const credential = makeCredential()
    const connection = makeConnection(credential)
    connection.headers = {
      "x-domain": "custom.codebuddy.example",
      "x-user-id": "manual-user",
      authorization: "Bearer wrong-token",
    }

    await codebuddyNativeAdapter.createChatCompletions?.({
      target: {
        upstreamModelId: "gpt-5.6-sol",
      } as Parameters<
        NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
      >[0]["target"],
      connection,
      credential,
      payload: { model: "gpt-5.6-sol", messages: [] },
    })

    expect(upstreamHeaders?.get("x-domain")).toBe("custom.codebuddy.example")
    expect(upstreamHeaders?.get("x-user-id")).toBe("manual-user")
    expect(upstreamHeaders?.get("authorization")).toBe(
      `Bearer ${credential.value}`,
    )
  })
})

describe("CodeBuddy token refresh", () => {
  test("uses JWT expiry when legacy context has no expiresAt", () => {
    const fresh = makeCredential({
      value: jwt(Math.floor(Date.now() / 1000) + 3600),
      context: {},
    })
    const expired = makeCredential({
      value: jwt(Math.floor(Date.now() / 1000) - 60),
      context: {},
    })

    expect(codebuddyNeedsRefresh(fresh)).toBe(false)
    expect(codebuddyNeedsRefresh(expired)).toBe(true)
  })

  test("refreshes an expired token before a request and stores rotated credentials", async () => {
    const oldToken = jwt(Math.floor(Date.now() / 1000) - 60)
    const newExpiry = Math.floor(Date.now() / 1000) + 3600
    const newToken = jwt(newExpiry)
    const credential = makeCredential({
      value: oldToken,
      context: {
        accountId: "codebuddy-connection",
        refreshToken: "old-refresh",
      },
    })
    const connection = makeConnection(credential)
    upsertProviderConnection(connection)

    const fetchMock = mock((_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${oldToken}`,
      )
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            data: { accessToken: newToken, refreshToken: "new-refresh" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await ensureCodebuddyAccessToken(connection, credential)

    expect(result).toBe(newToken)
    expect(credential.value).toBe(newToken)
    expect(credential.context?.refreshToken).toBe("new-refresh")
    expect(credential.context?.expiresAt).toBe(newExpiry * 1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("uses expiresIn when a refreshed access token has no JWT expiry", async () => {
    const credential = makeCredential({
      value: jwt(Math.floor(Date.now() / 1000) - 60),
      context: {
        accountId: "codebuddy-connection",
        refreshToken: "old-refresh",
      },
    })
    const connection = makeConnection(credential)
    connection.headers = { "x-user-id": "manual-user" }
    upsertProviderConnection(connection)

    const beforeRefresh = Date.now()
    const fetchMock = mock((_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["X-User-Id"]).toBe(
        "manual-user",
      )
      return Promise.resolve(
        Response.json({
          code: 0,
          data: {
            accessToken: "opaque-access-token",
            refreshToken: "new-refresh",
            expiresIn: 3600,
          },
        }),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await ensureCodebuddyAccessToken(connection, credential)).toBe(
      "opaque-access-token",
    )
    expect(credential.context?.expiresAt).toBeGreaterThanOrEqual(
      beforeRefresh + 3_600_000,
    )
    expect(codebuddyNeedsRefresh(credential)).toBe(false)
    expect(await ensureCodebuddyAccessToken(connection, credential)).toBe(
      "opaque-access-token",
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
