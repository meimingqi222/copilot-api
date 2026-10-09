/**
 * 连接级代理透传回归测试。
 *
 * 运行时是 Bun（`bun --smol ./dist/main.js start`），连接级代理只有一条生效
 * 路径：Bun 原生 `fetch` 的 `proxy` 选项。`~/lib/proxy` 的 undici 全局
 * dispatcher 在 Bun 下是空操作，所以每个 adapter 的每一次上游 fetch 都必须
 * 显式带上 `connection.proxyUrl`（`connectionFetchInit`）。
 *
 * 这个 bug 的失败方式是**静默**的：漏传代理时请求依然直连成功，只是绕过了
 * 代理 —— 日志里看不出任何异常。因此这里对每个 adapter 打桩
 * `globalThis.fetch`，逐个断言 `init.proxy`。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

import type {
  ApiCredential,
  ProviderConnection,
  ProviderProtocol,
  RouteTarget,
} from "~/lib/provider-connections"

import { refreshCodebuddyTokenForConnection } from "~/services/codebuddy/token-refresh"
import { refreshLobsteraiTokenForConnection } from "~/services/lobsterai/token-refresh"
import { anthropicCompatibleAdapter } from "~/services/protocols/anthropic-compatible"
import { codebuddyNativeAdapter } from "~/services/protocols/codebuddy-native"
import { commandCodeNativeAdapter } from "~/services/protocols/commandcode-native"
import { dimagentNativeAdapter } from "~/services/protocols/dimagent-native"
import { geminiCompatibleAdapter } from "~/services/protocols/gemini-compatible"
import { geminiNativeAdapter } from "~/services/protocols/gemini-native"
import { lobsteraiNativeAdapter } from "~/services/protocols/lobsterai-native"
import { minimaxNativeAdapter } from "~/services/protocols/minimax-native"
import { openAICompatibleAdapter } from "~/services/protocols/openai-compatible"
import { openAIResponsesCompatibleAdapter } from "~/services/protocols/openai-responses"
import { qoderNativeAdapter } from "~/services/protocols/qoder-native"
import { connectionFetchInit } from "~/services/protocols/shared"
import { zedNativeAdapter } from "~/services/protocols/zed-native"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const PROXY = "http://proxy.example.invalid:8080"

interface Captured {
  url: string
  init: RequestInit & { proxy?: string }
}

/** 打桩 fetch 并记录每次调用的 url + init（含非标准的 `proxy`）。 */
function stubFetch(
  respond: (url: string, callIndex: number) => Response,
): Array<Captured> {
  const calls: Array<Captured> = []
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const index = calls.length
      calls.push({
        url: String(url),
        init: (init ?? {}) as Captured["init"],
      })
      return respond(String(url), index)
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  return calls
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function makeConnection(
  protocol: ProviderProtocol,
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: `${protocol}-conn`,
    name: protocol,
    protocol,
    baseUrl: "https://upstream.test/v1",
    enabled: true,
    priority: 0,
    credentials: [],
    createdAt: 0,
    proxyUrl: PROXY,
    ...overrides,
  }
}

function makeCredential(overrides: Partial<ApiCredential> = {}): ApiCredential {
  return {
    id: "cred-1",
    authMode: "bearer",
    value: "sk-test",
    enabled: true,
    status: "ready",
    createdAt: 0,
    ...overrides,
  }
}

function makeTarget(
  connection: ProviderConnection,
  upstreamModelId: string,
  endpoint: RouteTarget["endpoint"],
): RouteTarget {
  return {
    connectionId: connection.id,
    connectionName: connection.name,
    protocol: connection.protocol,
    credentialId: "cred-1",
    publicModelId: upstreamModelId,
    upstreamModelId,
    endpoint,
    connectionPriority: 0,
    connectionWeight: 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }
}

const chatPayload = {
  model: "m",
  messages: [{ role: "user" as const, content: "hi" }],
  stream: false,
}

/** 断言 captured 的每一次上游调用都带上了连接代理。 */
function expectProxied(calls: Array<Captured>): void {
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) {
    expect(call.init.proxy).toBe(PROXY)
  }
}

describe("connectionFetchInit", () => {
  test("adds the Bun proxy option only when the connection has a proxy", () => {
    const withProxy = makeConnection("openai-compatible")
    expect(connectionFetchInit(withProxy, { method: "GET" })).toEqual({
      method: "GET",
      proxy: PROXY,
    })

    const without = makeConnection("openai-compatible", {
      proxyUrl: undefined,
    })
    expect(connectionFetchInit(without, { method: "GET" })).toEqual({
      method: "GET",
    })
  })

  test("falls back to metadata.proxyUrl for v1 connections", () => {
    const legacy = makeConnection("openai-compatible", {
      proxyUrl: undefined,
      metadata: { provider: "deepseek", proxyUrl: PROXY },
    })
    expect(connectionFetchInit(legacy, {}).proxy).toBe(PROXY)
  })
})

describe("openai-compatible adapter proxy wiring", () => {
  test("discovery, chat and embeddings all carry the connection proxy", async () => {
    const connection = makeConnection("openai-compatible")
    const credential = makeCredential()
    const calls = stubFetch((url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "m" }] })
      }
      if (url.endsWith("/embeddings")) {
        return jsonResponse({ object: "list", data: [] })
      }
      return jsonResponse({ choices: [], usage: {} })
    })

    await openAICompatibleAdapter.discoverModels!({ connection, credential })
    await openAICompatibleAdapter.createChatCompletions!({
      target: makeTarget(connection, "m", "chat"),
      connection,
      credential,
      payload: chatPayload,
    })
    await openAICompatibleAdapter.createEmbeddings?.({
      target: makeTarget(connection, "m", "embeddings"),
      connection,
      credential,
      payload: { model: "m", input: "hi" },
    })

    expect(calls.map((call) => call.url)).toEqual([
      "https://upstream.test/v1/models",
      "https://upstream.test/v1/chat/completions",
      "https://upstream.test/v1/embeddings",
    ])
    expectProxied(calls)
  })
})

describe("openai-responses-compatible adapter proxy wiring", () => {
  test("discovery, chat and responses all carry the connection proxy", async () => {
    const connection = makeConnection("openai-responses-compatible")
    const credential = makeCredential()
    const calls = stubFetch((url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "m" }] })
      }
      return jsonResponse({ id: "r", output: [] })
    })

    await openAIResponsesCompatibleAdapter.discoverModels!({
      connection,
      credential,
    })
    await openAIResponsesCompatibleAdapter.createChatCompletions!({
      target: makeTarget(connection, "m", "chat"),
      connection,
      credential,
      payload: chatPayload,
    })
    await openAIResponsesCompatibleAdapter.createResponses!({
      target: makeTarget(connection, "m", "responses"),
      connection,
      credential,
      payload: { model: "m", input: "hi", stream: false },
    })

    expect(calls.map((call) => call.url)).toEqual([
      "https://upstream.test/v1/models",
      "https://upstream.test/v1/chat/completions",
      "https://upstream.test/v1/responses",
    ])
    expectProxied(calls)
  })
})

describe("anthropic-compatible adapter proxy wiring", () => {
  test("messages and discovery carry the connection proxy", async () => {
    const connection = makeConnection("anthropic-compatible", {
      modelDiscovery: {
        enabled: true,
        mode: "manual-only",
        endpoint: "/models",
      },
    })
    const credential = makeCredential({ authMode: "header" })
    const calls = stubFetch((url) =>
      url.endsWith("/models") ?
        jsonResponse({ data: [{ id: "m" }] })
      : jsonResponse({ id: "msg", content: [] }),
    )

    await anthropicCompatibleAdapter.createMessages!({
      target: makeTarget(connection, "m", "messages"),
      connection,
      credential,
      payload: {
        model: "m",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      },
    })
    await anthropicCompatibleAdapter.discoverModels!({
      connection,
      credential,
    })

    expect(calls.map((call) => call.url)).toEqual([
      "https://upstream.test/v1/messages",
      "https://upstream.test/v1/models",
    ])
    expectProxied(calls)
  })
})

describe("gemini-compatible adapter proxy wiring", () => {
  test("generateContent and discovery carry the connection proxy", async () => {
    const connection = makeConnection("gemini-compatible")
    const credential = makeCredential()
    const calls = stubFetch((url) =>
      url.includes(":generateContent") ?
        jsonResponse({ candidates: [] })
      : jsonResponse({ models: [{ name: "models/m" }] }),
    )

    await geminiCompatibleAdapter.createGeminiGenerateContent!({
      target: makeTarget(connection, "m", "gemini"),
      connection,
      credential,
      payload: { contents: [{ parts: [{ text: "hi" }] }] },
    })
    await geminiCompatibleAdapter.discoverModels!({ connection, credential })

    expect(calls.map((call) => call.url)).toEqual([
      "https://upstream.test/v1/models/m:generateContent",
      "https://upstream.test/v1/models",
    ])
    expectProxied(calls)
  })
})

describe("gemini-native adapter proxy wiring", () => {
  test("generateContent carries the connection proxy", async () => {
    const connection = makeConnection("gemini-native", {
      metadata: { provider: "gemini" },
      credentials: [makeCredential({ context: { projectId: "proj-1" } })],
    })
    const credential = connection.credentials[0]!
    const calls = stubFetch(() => jsonResponse({ response: {} }))

    await geminiNativeAdapter.createGeminiGenerateContent!({
      target: makeTarget(connection, "m", "gemini"),
      connection,
      credential,
      payload: { contents: [{ parts: [{ text: "hi" }] }] },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("v1internal:generateContent")
    expectProxied(calls)
  })
})

describe("minimax-native adapter proxy wiring", () => {
  test("messages carry the connection proxy", async () => {
    const connection = makeConnection("minimax-native")
    const credential = makeCredential()
    const calls = stubFetch(() => jsonResponse({ id: "msg", content: [] }))

    await minimaxNativeAdapter.createMessages!({
      target: makeTarget(connection, "m", "messages"),
      connection,
      credential,
      payload: {
        model: "m",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      },
    })

    expect(calls.map((call) => call.url)).toEqual([
      "https://upstream.test/v1/messages",
    ])
    expectProxied(calls)
  })
})

describe("codebuddy-native adapter proxy wiring", () => {
  test("inline image fetch carries the connection proxy", async () => {
    // 未过期的 JWT：ensureCodebuddyAccessToken 不会再发刷新请求，于是只剩
    // 图片取回与聊天两条上游调用。图片用公网 IP 字面量，compatValidateRemoteUrl
    // 对 IP 字面量跳过 DNS 解析，所以这条用例离线可跑、不触网。
    const sub = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")
    const token = `h.${sub}.sig`
    const connection = makeConnection("codebuddy-native", {
      baseUrl: "https://www.workbuddy.ai/v2",
      metadata: { provider: "codebuddy" },
      credentials: [makeCredential({ value: token })],
    })
    const calls = stubFetch((url) => {
      if (url.includes("93.184.216.34")) {
        return new Response(
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          { status: 200, headers: { "content-type": "image/png" } },
        )
      }
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: {},
      })
    })

    type ChatArgs = Parameters<
      NonNullable<typeof codebuddyNativeAdapter.createChatCompletions>
    >[0]
    const payload = {
      model: "m",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image_url",
              image_url: { url: "https://93.184.216.34/a.png" },
            },
          ],
        },
      ],
    } as unknown as ChatArgs["payload"]

    await codebuddyNativeAdapter.createChatCompletions!({
      target: makeTarget(connection, "m", "chat"),
      connection,
      credential: makeCredential({ value: token }),
      payload,
    })

    const image = calls.find((call) => call.url.includes("93.184.216.34"))
    expect(image).toBeDefined()
    expect(image?.init.proxy).toBe(PROXY)
    expectProxied(calls)
  })

  test("model discovery carries the connection proxy", async () => {
    // 未过期的 JWT：ensureCodebuddyAccessToken 不会再发刷新请求，
    // 于是唯一的 fetch 就是 /v3/config。
    const sub = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")
    const token = `h.${sub}.sig`
    const connection = makeConnection("codebuddy-native", {
      baseUrl: "https://www.workbuddy.ai/v2",
      metadata: { provider: "codebuddy" },
      credentials: [makeCredential({ value: token })],
    })
    const calls = stubFetch(() =>
      jsonResponse({ code: 0, data: { models: [] } }),
    )

    await codebuddyNativeAdapter.discoverModels!({
      connection,
      credential: connection.credentials[0]!,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("/v3/config")
    expectProxied(calls)
  })
})

describe("qoder-native adapter proxy wiring", () => {
  test("model discovery carries the connection proxy", async () => {
    const connection = makeConnection("qoder-native", {
      baseUrl: "https://api3.qoder.sh",
      metadata: { provider: "qoder" },
      credentials: [
        makeCredential({
          context: { uid: "u-1", machineId: "machine-1", name: "n" },
        }),
      ],
    })
    const calls = stubFetch(() =>
      jsonResponse({
        chat: [{ key: "qwen3-coder", enable: true, source: "system" }],
      }),
    )

    await qoderNativeAdapter.discoverModels!({
      connection,
      credential: connection.credentials[0]!,
    })

    expect(calls).toHaveLength(1)
    expectProxied(calls)
  })
})

describe("lobsterai-native adapter proxy wiring", () => {
  test("model discovery carries the connection proxy", async () => {
    const connection = makeConnection("lobsterai-native", {
      baseUrl: "https://lobsterai.example.test",
      metadata: { provider: "lobsterai" },
      credentials: [makeCredential()],
    })
    const calls = stubFetch(() =>
      jsonResponse({ code: 0, data: [{ modelId: "m" }] }),
    )

    await lobsteraiNativeAdapter.discoverModels!({
      connection,
      credential: connection.credentials[0]!,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("/api/models/available")
    expectProxied(calls)
  })
})

describe("commandcode-native adapter proxy wiring", () => {
  test("model discovery carries the connection proxy", async () => {
    const connection = makeConnection("commandcode-native", {
      metadata: { provider: "commandcode" },
    })
    const calls = stubFetch(() => jsonResponse({ data: [{ id: "m" }] }))

    await commandCodeNativeAdapter.discoverModels!({
      connection,
      credential: makeCredential(),
    })

    expect(calls).toHaveLength(1)
    expectProxied(calls)
  })
})

describe("dimagent-native adapter proxy wiring", () => {
  test("model discovery carries the connection proxy", async () => {
    const connection = makeConnection("dimagent-native", {
      metadata: { provider: "dimagent" },
    })
    const calls = stubFetch(() => jsonResponse({ data: [{ id: "m" }] }))

    await dimagentNativeAdapter.discoverModels!({
      connection,
      credential: makeCredential(),
    })

    expect(calls).toHaveLength(1)
    expectProxied(calls)
  })
})

describe("zed-native adapter proxy wiring", () => {
  test("both the llm token exchange and the completion carry the proxy", async () => {
    const connection = makeConnection("zed-native", {
      baseUrl: "https://zed.dev",
      metadata: { provider: "zed" },
      credentials: [
        makeCredential({
          context: { zedUserId: "u-1", systemId: "s-1" },
        }),
      ],
    })
    const calls = stubFetch((url) =>
      url.includes("llm_tokens") ?
        jsonResponse({ token: "llm-token" })
      : new Response(JSON.stringify({ status: { done: true } }) + "\n", {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
    )

    await zedNativeAdapter.createMessages!({
      target: makeTarget(connection, "claude-sonnet-4", "messages"),
      connection,
      credential: connection.credentials[0]!,
      payload: {
        model: "claude-sonnet-4",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      },
    })

    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0]?.url).toContain("/client/llm_tokens")
    expectProxied(calls)
  })
})

/**
 * 自建 refresh 端点的两个 provider（CodeBuddy / LobsterAI）不走通用 OAuth
 * 刷新调度器，刷新请求发往与 chat 同一个上游主机 —— 漏传代理时 token 刷新
 * 会直连失败，连接退化到 auth_error（而不是静默直连）。
 */
describe("native token refresh proxy wiring", () => {
  test("codebuddy refresh carries the connection proxy", async () => {
    const connection = makeConnection("codebuddy-native", {
      baseUrl: "https://www.workbuddy.ai/v2",
      metadata: { provider: "codebuddy" },
      credentials: [
        makeCredential({
          value: "old.jwt",
          context: { refreshToken: "rt-1", accountId: "codebuddy-native-conn" },
        }),
      ],
    })
    const calls = stubFetch(() =>
      jsonResponse({ code: 0, data: { accessToken: "new.jwt" } }),
    )

    expect(await refreshCodebuddyTokenForConnection(connection)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("/plugin/auth/token/refresh")
    expectProxied(calls)
  })

  test("lobsterai refresh carries the connection proxy", async () => {
    const connection = makeConnection("lobsterai-native", {
      baseUrl: "https://lobsterai.example.test",
      metadata: { provider: "lobsterai" },
      credentials: [
        makeCredential({
          value: "old.jwt",
          context: { refreshToken: "rt-1" },
        }),
      ],
    })
    const calls = stubFetch(() =>
      jsonResponse({ code: 0, data: { accessToken: "new.jwt" } }),
    )

    expect(await refreshLobsteraiTokenForConnection(connection)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("/api/auth/refresh")
    expectProxied(calls)
  })
})

/**
 * 静态不变量：src/services/protocols 下每一个调 `fetch` 的文件都必须提到某个
 * 透传代理的 helper。这条规则把"新 adapter 直接裸调 fetch"变成红测试，而不是
 * 一个只有线上才能发现的静默绕行。
 *
 * 只约束 protocols/ 目录：目录外（windsurf / codebuff / copilot / 图片内联等）
 * 的 fetch 不都携带 connection（见 2026-10-09-connection-proxy-wiring.md）。
 */
describe("protocol adapters never fetch without a proxy helper", () => {
  const adapterDir = path.join(process.cwd(), "src/services/protocols")
  const proxyHelper = /connectionFetchInit|withProxyUrl|oauthFetch/
  // 裸调 fetch：前面不是 `.`（排除 globalThis.fetch / options.fetch）。
  const bareFetch = /(^|[^.\w])fetch\(/m

  test("every fetching protocol module mentions a proxy helper", () => {
    const offenders: Array<string> = []
    for (const entry of readdirSync(adapterDir)) {
      if (!entry.endsWith(".ts")) continue
      const source = readFileSync(path.join(adapterDir, entry), "utf8")
      if (!bareFetch.test(source)) continue
      if (!proxyHelper.test(source)) offenders.push(entry)
    }
    expect(offenders).toEqual([])
  })
})
