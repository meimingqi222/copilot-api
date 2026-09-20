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
import { codebuddyNativeAdapter } from "~/services/protocols/codebuddy-native"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  cancelAllCodebuddyRefreshTimers()
  __resetProviderConnectionsForTest()
})

function jwt(exp: number, sub = "user-1"): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode({ exp, sub })}.signature`
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
    baseUrl: "https://www.codebuddy.ai/v2",
    headers: { "X-Domain": "www.codebuddy.ai" },
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
      "keep [redacted] out of logs",
    )
    expect(upstreamBody?.tools?.[0]?.function.description).toBe(
      "find [redacted]",
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
})
