/**
 * Qoder provider 接入测试。
 *
 * 覆盖逆向自 Qoder 客户端的关键约定：
 * - 出站 body 是**自定义编码串**（不是 JSON），并带全套 COSY 头 +
 *   X-Model-Key / X-Model-Source
 * - 上游只有流式：`data:<外层信封>` 里的 `body` 是标准 OpenAI chunk
 * - content 里内嵌的 `<tool_call>` XML 要被提升成原生 tool_calls；
 *   原生 tool_calls 的 id 必须原样保留
 * - 外层 statusCodeValue ≠ 200 是错误，状态要归一到 200–599
 * - 模型发现走 /algo/api/v2/model/list
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections/types"

import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import { decodeRequestBody } from "~/services/qoder/codec"
import { qoderChatUrl } from "~/services/qoder/endpoints"
import {
  parseQoderModelList,
  qoderModelMappings,
} from "~/services/qoder/models"
import {
  detectQoderStreamError,
  qoderNativeAdapter,
} from "~/services/protocols/qoder-native"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
})

/** 一份贴近真实响应的 model/list（含聚合条目与未启用条目）。 */
const MODEL_LIST = {
  chat: [
    {
      key: "claude-sonnet-4-6",
      source: "anthropic",
      enable: true,
      display_name: "Claude Sonnet 4.6",
      is_vl: true,
      is_reasoning: true,
      max_input_tokens: 200000,
      thinking_config: {
        enabled: {
          efforts: { low: {}, medium: { is_default: true }, high: {} },
        },
      },
    },
    { key: "auto", source: "", enable: true },
    { key: "retired", source: "", enable: false },
  ],
}

function makeConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  const now = Date.now()
  return {
    id: "qoder-conn",
    name: "Qoder",
    protocol: "qoder-native",
    baseUrl: "https://api3.qoder.sh",
    enabled: true,
    priority: 0,
    credentials: [makeCredential()],
    models: qoderModelMappings(parseQoderModelList(MODEL_LIST)),
    createdAt: now,
    ...overrides,
  } as ProviderConnection
}

function makeCredential(overrides: Partial<ApiCredential> = {}): ApiCredential {
  const now = Date.now()
  return {
    id: "cred-qoder",
    authMode: "bearer",
    value: "jt-token",
    enabled: true,
    status: "ready",
    context: {
      uid: "uid-1",
      machineId: "machine-1",
      name: "Qoder User",
      email: "q@x.dev",
      refreshToken: "jrt-1",
    },
    createdAt: now,
    ...overrides,
  } as ApiCredential
}

/** 一条 Qoder SSE 帧：外层信封 + 内层 OpenAI chunk。 */
function outerFrame(inner: unknown, statusCodeValue = 200): string {
  return `data: ${JSON.stringify({
    statusCodeValue,
    body: typeof inner === "string" ? inner : JSON.stringify(inner),
  })}\n\n`
}

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

const chatTarget = (upstreamModelId: string) =>
  ({
    upstreamModelId,
    publicModelId: upstreamModelId,
  }) as unknown as Parameters<
    NonNullable<typeof qoderNativeAdapter.createChatCompletions>
  >[0]["target"]

/** 收集流式事件里的 data 帧（去掉 [DONE]）。 */
async function collectFrames(
  stream: AsyncIterable<{ data?: string }>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const event of stream) {
    if (!event.data || event.data === "[DONE]") continue
    out.push(JSON.parse(event.data) as Record<string, unknown>)
  }
  return out
}

// ── 流内错误 ────────────────────────────────────────────────────────

describe("detectQoderStreamError", () => {
  test("maps a non-200 statusCodeValue to a legal HTTP status", () => {
    const error = detectQoderStreamError({
      data: JSON.stringify({
        statusCodeValue: 401,
        body: JSON.stringify({ message: "token expired" }),
      }),
    })
    expect(error?.response.status).toBe(401)
    expect(error?.message).toContain("sign in again")
  })

  test("maps a quota failure to 429", () => {
    const error = detectQoderStreamError({
      data: JSON.stringify({
        statusCodeValue: 400,
        body: JSON.stringify({ message: "usage quota exceeded" }),
      }),
    })
    expect(error?.response.status).toBe(429)
  })

  test("keeps a legal upstream status and ignores healthy frames", () => {
    expect(
      detectQoderStreamError({
        data: JSON.stringify({ statusCodeValue: 503, body: "" }),
      })?.response.status,
    ).toBe(503)
    expect(
      detectQoderStreamError({
        data: JSON.stringify({ statusCodeValue: 200, body: "{}" }),
      }),
    ).toBeNull()
    expect(detectQoderStreamError({ data: "not json" })).toBeNull()
    expect(detectQoderStreamError({})).toBeNull()
  })
})

// ── 模型发现 ────────────────────────────────────────────────────────

describe("qoderNativeAdapter.discoverModels", () => {
  test("maps model/list into chat mappings with config metadata", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = mock(
      (url: string, init: { headers: Record<string, string> }) => {
        seen.push({ url, headers: init.headers })
        return Promise.resolve(jsonResponse(MODEL_LIST))
      },
    ) as unknown as typeof fetch

    const models = await qoderNativeAdapter.discoverModels?.({
      connection: makeConnection(),
      credential: makeCredential(),
    })

    expect(seen[0]?.url).toBe(
      "https://api3.qoder.sh/algo/api/v2/model/list?Encode=1",
    )
    expect(seen[0]?.headers.Authorization?.startsWith("Bearer COSY.")).toBe(
      true,
    )
    expect(seen[0]?.headers["Cosy-User"]).toBe("uid-1")
    // 聚合条目（auto）与未启用条目都被丢掉。
    expect(models?.map((m) => m.publicId)).toEqual(["claude-sonnet-4-6"])
    expect(models?.[0]?.name).toBe("Claude Sonnet 4.6")
    expect(models?.[0]?.endpoints).toEqual(["chat"])
    expect(models?.[0]?.metadata?.qoderSource).toBe("anthropic")
    expect(
      (models?.[0]?.metadata?.qoderModelConfig as Record<string, unknown>).key,
    ).toBe("claude-sonnet-4-6")
  })
})

// ── chat：出站编码 + COSY 头 ────────────────────────────────────────

describe("qoderNativeAdapter.createChatCompletions", () => {
  test("sends the encoded envelope with COSY and model headers", async () => {
    const seen: Array<{
      url: string
      headers: Record<string, string>
      body: string
    }> = []
    globalThis.fetch = mock(
      (
        url: string,
        init: { headers: Record<string, string>; body: string },
      ) => {
        seen.push({ url, headers: init.headers, body: init.body })
        return Promise.resolve(
          sseResponse([
            outerFrame({
              id: "c1",
              created: 1700000000,
              choices: [
                { index: 0, delta: { content: "hi" }, finish_reason: null },
              ],
            }),
            outerFrame({
              id: "c1",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 7,
                completion_tokens: 2,
                total_tokens: 9,
              },
            }),
          ]),
        )
      },
    ) as unknown as typeof fetch

    const result = await qoderNativeAdapter.createChatCompletions?.({
      target: chatTarget("claude-sonnet-4-6"),
      connection: makeConnection(),
      credential: makeCredential(),
      payload: {
        model: "claude-sonnet-4-6",
        stream: true,
        max_tokens: 4096,
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "get_time", parameters: { type: "object" } },
          },
        ],
      },
    })

    const call = seen[0]!
    expect(call.url).toBe(qoderChatUrl())
    // wire body 是自定义编码串，不是 JSON 引号包裹。
    expect(call.body.startsWith("{")).toBe(false)
    expect(call.headers["Accept"]).toBe("text/event-stream")
    expect(call.headers["X-Model-Key"]).toBe("claude-sonnet-4-6")
    expect(call.headers["X-Model-Source"]).toBe("anthropic")
    expect(call.headers["Authorization"]?.startsWith("Bearer COSY.")).toBe(true)
    expect(call.headers["Cosy-MachineId"]).toBe("machine-1")
    // 签名覆盖 path（去掉 /algo 与 query），且 body 参与签名。
    expect(call.headers["Cosy-Date"]).toMatch(/^\d+$/)

    // 解码回明文封套：模型配置原样回传、思考档位来自模型自身默认值。
    const envelope = JSON.parse(
      Buffer.from(decodeRequestBody(call.body)).toString("utf8"),
    ) as Record<string, unknown>
    expect(envelope.agent_id).toBe("agent_common")
    expect(envelope.task_id).toBe("common")
    expect(envelope.session_type).toBe("app")
    expect(
      (envelope.parameters as Record<string, unknown>).enable_thinking,
    ).toBe(true)
    expect(
      (envelope.parameters as Record<string, unknown>).reasoning_effort,
    ).toBe("medium")
    expect((envelope.parameters as Record<string, unknown>).max_tokens).toBe(
      4096,
    )
    expect((envelope.model_config as Record<string, unknown>).key).toBe(
      "claude-sonnet-4-6",
    )
    const messages = envelope.messages as Array<Record<string, unknown>>
    expect(messages[0]?.role).toBe("system")
    expect(JSON.stringify(messages[0])).toContain("be terse")
    expect(messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    })
    expect(envelope.tools).toHaveLength(1)

    const frames = await collectFrames(
      (result as { response: AsyncIterable<{ data?: string }> }).response,
    )
    expect(frames[0]?.object).toBe("chat.completion.chunk")
    expect(frames.at(-1)?.usage).toMatchObject({ prompt_tokens: 7 })
  })

  test("lifts embedded <tool_call> XML into native tool_calls", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          outerFrame({
            id: "c1",
            choices: [
              {
                index: 0,
                delta: {
                  content:
                    'Sure. <tool_call><function=get_time><parameter=tz>"UTC"</parameter></function></tool_call> done',
                },
                finish_reason: null,
              },
            ],
          }),
          outerFrame({
            id: "c1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        ]),
      ),
    ) as unknown as typeof fetch

    const result = await qoderNativeAdapter.createChatCompletions?.({
      target: chatTarget("claude-sonnet-4-6"),
      connection: makeConnection(),
      credential: makeCredential(),
      payload: {
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "time?" }],
      },
    })
    const frames = await collectFrames(
      (result as { response: AsyncIterable<{ data?: string }> }).response,
    )
    const contents = frames
      .map(
        (f) =>
          (f.choices as Array<{ delta?: { content?: string } }>)[0]?.delta
            ?.content,
      )
      .filter((c): c is string => typeof c === "string")
    expect(contents.join("")).toBe("Sure.  done")

    const callFrame = frames.find(
      (f) =>
        (f.choices as Array<{ delta?: { tool_calls?: unknown } }>)[0]?.delta
          ?.tool_calls,
    )
    const call = (
      callFrame!.choices as Array<{
        delta: {
          tool_calls: Array<{
            index: number
            id: string
            function: { name: string; arguments: string }
          }>
        }
      }>
    )[0]!.delta.tool_calls[0]!
    expect(call.function.name).toBe("get_time")
    expect(JSON.parse(call.function.arguments)).toEqual({ tz: "UTC" })
    expect(call.id.startsWith("call_")).toBe(true)
    // sawTool ⇒ finish_reason 归一到 tool_calls，客户端才会去执行。
    const finish = frames.at(-1)?.choices as Array<{ finish_reason?: string }>
    expect(finish[0]?.finish_reason).toBe("tool_calls")
  })

  test("preserves upstream tool_call ids and reasoning deltas", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          outerFrame({
            id: "c1",
            choices: [
              {
                index: 0,
                delta: { reasoning_content: " thinking" },
                finish_reason: null,
              },
            ],
          }),
          outerFrame({
            id: "c1",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_upstream_1",
                      type: "function",
                      function: { name: "read_file", arguments: '{"p":' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
          outerFrame({
            id: "c1",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: '"a"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
          outerFrame({
            id: "c1",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          }),
        ]),
      ),
    ) as unknown as typeof fetch

    const result = await qoderNativeAdapter.createChatCompletions?.({
      target: chatTarget("claude-sonnet-4-6"),
      connection: makeConnection(),
      credential: makeCredential(),
      payload: {
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "read" }],
      },
    })
    const frames = await collectFrames(
      (result as { response: AsyncIterable<{ data?: string }> }).response,
    )
    const reasoning = frames
      .map(
        (f) =>
          (f.choices as Array<{ delta?: { reasoning_content?: string } }>)[0]
            ?.delta?.reasoning_content,
      )
      .filter((c): c is string => typeof c === "string")
    expect(reasoning.join("")).toBe(" thinking")

    const ids = frames.flatMap((f) =>
      (
        (
          f.choices as Array<{
            delta?: { tool_calls?: Array<{ id?: string }> }
          }>
        )[0]?.delta?.tool_calls ?? []
      )
        .map((tc) => tc.id)
        .filter((id): id is string => typeof id === "string"),
    )
    expect(ids).toEqual(["call_upstream_1"])
  })

  test("aggregates for a non-stream request", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          outerFrame({
            id: "c1",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Hel" },
                finish_reason: null,
              },
            ],
          }),
          outerFrame({
            id: "c1",
            choices: [
              { index: 0, delta: { content: "lo" }, finish_reason: null },
            ],
          }),
          outerFrame({
            id: "c1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }),
        ]),
      ),
    ) as unknown as typeof fetch

    const result = await qoderNativeAdapter.createChatCompletions?.({
      target: chatTarget("claude-sonnet-4-6"),
      connection: makeConnection(),
      credential: makeCredential(),
      payload: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      },
    })
    const response = (
      result as unknown as { response: Record<string, unknown> }
    ).response
    expect(response.object).toBe("chat.completion")
    expect(response.model).toBe("claude-sonnet-4-6")
    const choice = (response.choices as Array<Record<string, unknown>>)[0]
    expect(choice?.finish_reason).toBe("stop")
    expect(choice?.message).toMatchObject({
      role: "assistant",
      content: "Hello",
    })
  })

  test("rejects when the first frame carries an upstream failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([outerFrame(JSON.stringify({ message: "boom" }), 503)]),
      ),
    ) as unknown as typeof fetch

    await expect(
      qoderNativeAdapter.createChatCompletions?.({
        target: chatTarget("claude-sonnet-4-6"),
        connection: makeConnection(),
        credential: makeCredential(),
        payload: {
          model: "claude-sonnet-4-6",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
      }),
    ).rejects.toMatchObject({ response: { status: 503 } })
  })

  test("surfaces a mid-stream failure instead of a silent cutoff", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          outerFrame({
            id: "c1",
            choices: [
              { index: 0, delta: { content: "par" }, finish_reason: null },
            ],
          }),
          outerFrame(JSON.stringify({ message: "usage quota exceeded" }), 429),
        ]),
      ),
    ) as unknown as typeof fetch

    const result = await qoderNativeAdapter.createChatCompletions?.({
      target: chatTarget("claude-sonnet-4-6"),
      connection: makeConnection(),
      credential: makeCredential(),
      payload: {
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    })
    await expect(
      collectFrames(
        (result as { response: AsyncIterable<{ data?: string }> }).response,
      ),
    ).rejects.toMatchObject({ response: { status: 429 } })
  })

  test("refuses a model without its upstream configuration", async () => {
    const fetchMock = mock(() => Promise.resolve(sseResponse([])))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      qoderNativeAdapter.createChatCompletions?.({
        target: chatTarget("unknown-model"),
        connection: makeConnection({ models: [] }),
        credential: makeCredential(),
        payload: {
          model: "unknown-model",
          messages: [{ role: "user", content: "hi" }],
        },
      }),
    ).rejects.toMatchObject({ response: { status: 400 } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── 端到端路由 ──────────────────────────────────────────────────────

describe("Qoder end-to-end routing", () => {
  const isolationRoot = PATHS.APP_DIR
  let tempAppDir = ""
  const originalApiKey = state.legacyApiKey

  beforeEach(async () => {
    tempAppDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `qoder-e2e-${randomUUID()}-`),
    )
    redirectPathsToDir(tempAppDir)
    __resetProviderConnectionsForTest()
    statsStore.clearUsageStatsForTest()
    resetProtectedRouteGuardForTest()
    state.legacyApiKey = undefined
    // 必须用 upsert（而不是 createConnection）：COSY 签名要读 credential.context
    // 里的 uid / machineId，而 createConnection 的入参不接受 context。
    upsertProviderConnection(
      makeConnection({
        id: "qoder-e2e",
        name: "Qoder",
      }),
    )
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

  test("routes /v1/chat/completions to the Qoder SSE endpoint", async () => {
    let sentUrl = ""
    let sentHeaders: Record<string, string> = {}
    let sentBody = ""

    globalThis.fetch = mock(
      (
        url: string,
        init: { headers: Record<string, string>; body: string },
      ) => {
        sentUrl = url
        sentHeaders = init.headers
        sentBody = init.body
        return Promise.resolve(
          sseResponse([
            outerFrame({
              id: "e2e-1",
              created: 1700000000,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "hi" },
                  finish_reason: null,
                },
              ],
            }),
            outerFrame({
              id: "e2e-1",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          ]),
        )
      },
    ) as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(sentUrl).toBe(qoderChatUrl())
    expect(sentHeaders["X-Model-Key"]).toBe("claude-sonnet-4-6")
    expect(sentHeaders["Authorization"]?.startsWith("Bearer COSY.")).toBe(true)

    const envelope = JSON.parse(
      Buffer.from(decodeRequestBody(sentBody)).toString("utf8"),
    ) as Record<string, unknown>
    expect((envelope.model_config as Record<string, unknown>).key).toBe(
      "claude-sonnet-4-6",
    )

    const text = await response.text()
    expect(text).toContain("chat.completion.chunk")
    expect(text).toContain("[DONE]")
  })
})
