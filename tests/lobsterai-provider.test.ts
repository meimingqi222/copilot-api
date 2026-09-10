/**
 * LobsterAI（有道龙虾）provider 接入测试。
 *
 * 覆盖逆向自 LobsterAI 客户端的关键约定：
 * - 请求头：Bearer + X-LobsterAI-Client-{Capabilities,Version}
 * - 后端**恒定流式**：即使 stream:false 也返回 SSE，需本地聚合
 * - 错误以 HTTP 200 + `event:error` 帧下发，且 code 是 5 位业务码
 *   （如 40300），必须归一化为合法 HTTP 状态，否则会被静默忽略
 * - 模型发现走 /api/models/available
 * - token 刷新走 /api/auth/refresh
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections/types"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import { refreshLobsteraiTokenForConnection } from "~/services/lobsterai/token-refresh"
import {
  buildLobsteraiHeaders,
  detectLobsteraiStreamError,
  LOBSTERAI_CLIENT_CAPABILITIES,
  lobsteraiNativeAdapter,
  normalizeLobsteraiErrorStatus,
} from "~/services/protocols/lobsterai-native"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ── 夹具 ────────────────────────────────────────────────────────────

function makeConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: "lobsterai-conn",
    name: "LobsterAI",
    protocol: "lobsterai-native",
    baseUrl: "https://lobsterai-server.youdao.com",
    enabled: true,
    priority: 0,
    credentials: [],
    createdAt: Date.now(),
    ...overrides,
  } as ProviderConnection
}

function makeCredential(overrides: Partial<ApiCredential> = {}): ApiCredential {
  return {
    id: "cred-1",
    authMode: "bearer",
    value: "eyJ-access-token",
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
    ...overrides,
  } as ApiCredential
}

/** 构造一个 SSE 响应体。 */
function sseResponse(frames: Array<string>): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

// ── 请求头 ──────────────────────────────────────────────────────────

describe("buildLobsteraiHeaders", () => {
  test("sends Bearer auth plus the official client capability headers", () => {
    const headers = buildLobsteraiHeaders(
      makeConnection(),
      makeCredential({ value: "tok-123" }),
    )
    expect(headers.Authorization).toBe("Bearer tok-123")
    expect(headers["X-LobsterAI-Client-Capabilities"]).toBe(
      LOBSTERAI_CLIENT_CAPABILITIES,
    )
    expect(headers["X-LobsterAI-Client-Version"]).toBe("2026.9.4")
    expect(headers["Content-Type"]).toBe("application/json")
  })

  test("connection headers win over the defaults", () => {
    const headers = buildLobsteraiHeaders(
      makeConnection({
        headers: { "X-LobsterAI-Client-Version": "2099.1.1" },
      }),
      makeCredential(),
    )
    expect(headers["X-LobsterAI-Client-Version"]).toBe("2099.1.1")
  })
})

// ── 业务错误码归一化 ────────────────────────────────────────────────

describe("normalizeLobsteraiErrorStatus", () => {
  test("keeps a real HTTP status as-is", () => {
    expect(normalizeLobsteraiErrorStatus(429)).toBe(429)
    expect(normalizeLobsteraiErrorStatus(503)).toBe(503)
  })

  test("derives a valid status from a 5-digit business code", () => {
    // 40300（模型不支持）→ 403；这是官方客户端实际返回的错误码。
    expect(normalizeLobsteraiErrorStatus(40300)).toBe(403)
    expect(normalizeLobsteraiErrorStatus(50000)).toBe(500)
  })

  test("falls back to 500 for unclassifiable codes", () => {
    expect(normalizeLobsteraiErrorStatus(undefined)).toBe(500)
    expect(normalizeLobsteraiErrorStatus("nope")).toBe(500)
    expect(normalizeLobsteraiErrorStatus(7)).toBe(500)
  })
})

// ── 流内错误检测 ────────────────────────────────────────────────────

describe("detectLobsteraiStreamError", () => {
  test("turns an event:error frame into a valid-status HTTPError", () => {
    const frame = JSON.stringify({
      type: "error",
      error: {
        type: "proxy_error",
        message: "不支持的模型: nope",
        code: 40300,
      },
    })
    const error = detectLobsteraiStreamError({ event: "error", data: frame })
    expect(error).not.toBeNull()
    // 关键：状态必须合法（200–599），否则构造 Response 会抛 RangeError
    // 并被上层 try/catch 吞掉，错误帧将被静默忽略。
    expect(error?.response.status).toBe(403)
    expect(error?.message).toContain("不支持的模型")
    expect(error?.responseBody).toBe(frame)
  })

  test("ignores normal data chunks", () => {
    const frame = JSON.stringify({
      choices: [{ index: 0, delta: { content: "hi" } }],
    })
    expect(detectLobsteraiStreamError({ data: frame })).toBeNull()
  })

  test("ignores non-JSON and empty payloads", () => {
    expect(detectLobsteraiStreamError({ data: "[DONE]" })).toBeNull()
    expect(detectLobsteraiStreamError({ data: "not json" })).toBeNull()
    expect(detectLobsteraiStreamError({})).toBeNull()
  })
})

// ── 模型发现 ────────────────────────────────────────────────────────

describe("lobsteraiNativeAdapter.discoverModels", () => {
  test("maps /api/models/available into chat model mappings", async () => {
    const fetchMock = mock((url: string) => {
      expect(url).toBe(
        "https://lobsterai-server.youdao.com/api/models/available",
      )
      return Promise.resolve(
        jsonResponse({
          code: 0,
          message: "success",
          data: [
            {
              modelId: "deepseek-flash",
              modelName: "DeepSeek-V4.1-Flash",
              provider: "LobsterAI",
              contextWindow: 1_000_000,
            },
            { modelId: "glm-5.3", modelName: "GLM-5.3", provider: "LobsterAI" },
            { modelName: "no-id-should-be-skipped" },
          ],
        }),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const models = await lobsteraiNativeAdapter.discoverModels?.({
      connection: makeConnection(),
      credential: makeCredential(),
    })

    expect(models).toEqual([
      expect.objectContaining({
        publicId: "deepseek-flash",
        upstreamId: "deepseek-flash",
        name: "DeepSeek-V4.1-Flash",
        endpoints: ["chat"],
        enabled: true,
        pickerEnabled: true,
      }),
      expect.objectContaining({ publicId: "glm-5.3", name: "GLM-5.3" }),
    ])
  })

  test("throws instead of silently returning nothing on a business error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ code: 40100, message: "unauthorized" })),
    ) as unknown as typeof fetch

    await expect(
      lobsteraiNativeAdapter.discoverModels?.({
        connection: makeConnection(),
        credential: makeCredential(),
      }),
    ).rejects.toThrow(/code=40100/)
  })
})

// ── chat：强制流式 + 非流式聚合 ─────────────────────────────────────

describe("lobsteraiNativeAdapter.createChatCompletions", () => {
  const target = {
    upstreamModelId: "deepseek-flash",
  } as unknown as Parameters<
    NonNullable<typeof lobsteraiNativeAdapter.createChatCompletions>
  >[0]["target"]

  test("forces stream:true upstream and aggregates for a non-stream request", async () => {
    let sentBody: { stream?: boolean; model?: string } = {}
    globalThis.fetch = mock((_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body) as typeof sentBody
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({
            id: "c1",
            created: 1700000000,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Hel" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "c1",
            choices: [
              {
                index: 0,
                delta: { content: "lo", reasoning_content: "thinking" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "c1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      )
    }) as unknown as typeof fetch

    const result = await lobsteraiNativeAdapter.createChatCompletions?.({
      target,
      connection: makeConnection(),
      credential: makeCredential(),
      payload: {
        model: "deepseek-flash",
        messages: [{ role: "user", content: "hi" }],
      },
    })

    // 上游必须收到 stream:true —— 后端恒定流式，不接受非流式请求。
    expect(sentBody.stream).toBe(true)
    expect(sentBody.model).toBe("deepseek-flash")

    expect(result).toBeDefined()
    const response = (
      result as unknown as { response: Record<string, unknown> }
    ).response
    expect(response).toMatchObject({
      object: "chat.completion",
      model: "deepseek-flash",
    })
    const choice = (response.choices as Array<Record<string, unknown>>)[0]
    expect(choice.finish_reason).toBe("stop")
    expect(choice.message).toMatchObject({
      role: "assistant",
      content: "Hello",
      reasoning_content: "thinking",
    })
  })

  test("passes the SSE stream through for a streaming request", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: "hi" } }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      ),
    ) as unknown as typeof fetch

    const result = await lobsteraiNativeAdapter.createChatCompletions?.({
      target,
      connection: makeConnection(),
      credential: makeCredential(),
      payload: {
        model: "deepseek-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    })

    const response = (result as { response: AsyncIterable<unknown> }).response
    expect(typeof response[Symbol.asyncIterator]).toBe("function")
  })

  test("surfaces an in-stream error frame instead of a silent cutoff", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: "proxy_error", message: "boom", code: 50000 },
          })}\n\n`,
        ]),
      ),
    ) as unknown as typeof fetch

    await expect(
      lobsteraiNativeAdapter.createChatCompletions?.({
        target,
        connection: makeConnection(),
        credential: makeCredential(),
        payload: {
          model: "deepseek-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
      }),
    ).rejects.toThrow()
  })
})

// ── token 刷新 ──────────────────────────────────────────────────────

describe("refreshLobsteraiTokenForConnection", () => {
  test("posts the keyfrom body and writes the new tokens back", async () => {
    let sentUrl = ""
    let sentBody: Record<string, string> = {}
    globalThis.fetch = mock((url: string, init: { body: string }) => {
      sentUrl = url
      sentBody = JSON.parse(init.body) as Record<string, string>
      return Promise.resolve(
        jsonResponse({
          code: 0,
          data: {
            accessToken: "eyJ-new-access",
            refreshToken: "eyJ-new-refresh",
            userId: "89559",
          },
        }),
      )
    }) as unknown as typeof fetch

    const credential = makeCredential({
      value: "eyJ-old-access",
      context: {
        refreshToken: "eyJ-old-refresh",
        uuid: "uuid-1",
        userId: "89559",
        firstKeyfrom: "official",
        latestKeyfrom: "official",
      },
    })
    const connection = makeConnection({ credentials: [credential] })

    const ok = await refreshLobsteraiTokenForConnection(connection)

    expect(ok).toBe(true)
    expect(sentUrl).toBe("https://lobsterai-server.youdao.com/api/auth/refresh")
    expect(sentBody.refreshToken).toBe("eyJ-old-refresh")
    expect(sentBody.uuid).toBe("uuid-1")
    expect(sentBody.userId).toBe("89559")
    expect(sentBody.firstKeyfrom).toBe("official")
    expect(sentBody.version).toBe("2026.9.4")

    expect(credential.value).toBe("eyJ-new-access")
    expect((credential.context as { refreshToken?: string }).refreshToken).toBe(
      "eyJ-new-refresh",
    )
  })

  test("returns false without mutating on a business error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ code: 40100, message: "expired" })),
    ) as unknown as typeof fetch

    const credential = makeCredential({
      value: "eyJ-old-access",
      context: { refreshToken: "eyJ-old-refresh" },
    })
    const connection = makeConnection({ credentials: [credential] })

    const ok = await refreshLobsteraiTokenForConnection(connection)

    expect(ok).toBe(false)
    expect(credential.value).toBe("eyJ-old-access")
  })

  test("returns false when no refresh token is present", async () => {
    const credential = makeCredential({ context: {} })
    const connection = makeConnection({ credentials: [credential] })
    expect(await refreshLobsteraiTokenForConnection(connection)).toBe(false)
  })
})

// ── 端到端路由 ──────────────────────────────────────────────────────
// 验证 provider/protocol 已正确接线：连接可被路由，且请求真正打到
// /api/proxy/v1/chat/completions 并带上客户端标识头。

describe("LobsterAI end-to-end routing", () => {
  const isolationRoot = PATHS.APP_DIR
  let tempAppDir = ""
  const originalApiKey = state.legacyApiKey

  beforeEach(async () => {
    tempAppDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `lobsterai-e2e-${randomUUID()}-`),
    )
    redirectPathsToDir(tempAppDir)
    __resetProviderConnectionsForTest()
    statsStore.clearUsageStatsForTest()
    resetProtectedRouteGuardForTest()
    state.legacyApiKey = undefined
    await createConnection({
      id: "lobsterai-e2e",
      name: "LobsterAI",
      protocol: "lobsterai-native",
      baseUrl: "https://lobsterai-server.youdao.com",
      credentials: [
        { id: "cred-e2e", value: "eyJ-access-token", authMode: "bearer" },
      ],
      models: [
        {
          publicId: "deepseek-flash",
          upstreamId: "deepseek-flash",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    redirectPathsToDir(isolationRoot)
    __resetProviderConnectionsForTest()
    state.legacyApiKey = originalApiKey
    if (tempAppDir) {
      await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("routes to /api/proxy/v1/chat/completions with the client headers", async () => {
    let sentUrl = ""
    let sentHeaders: Record<string, string> = {}
    let sentBody: { stream?: boolean; model?: string } = {}

    globalThis.fetch = mock(
      (
        url: string,
        init: { headers: Record<string, string>; body: string },
      ) => {
        sentUrl = url
        sentHeaders = init.headers
        sentBody = JSON.parse(init.body) as typeof sentBody
        return Promise.resolve(
          sseResponse([
            `data: ${JSON.stringify({
              id: "e2e-1",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "hi" },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: "e2e-1",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
            "data: [DONE]\n\n",
          ]),
        )
      },
    ) as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-flash",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(sentUrl).toBe(
      "https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions",
    )
    expect(sentHeaders.Authorization).toBe("Bearer eyJ-access-token")
    expect(sentHeaders["X-LobsterAI-Client-Version"]).toBe("2026.9.4")
    expect(sentHeaders["X-LobsterAI-Client-Capabilities"]).toBe(
      LOBSTERAI_CLIENT_CAPABILITIES,
    )
    expect(sentBody.model).toBe("deepseek-flash")
    expect(sentBody.stream).toBe(true)
    await response.text()
  })
})
