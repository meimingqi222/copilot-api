/**
 * `/responses/compact` 上下文压缩的端到端测试。
 *
 * 覆盖：codex 上游透传、stream 拒绝、xAI 强制官方地址 + body 清洗、
 * 不兼容协议不污染状态、内联 compaction_trigger 翻译。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  getProviderConnection,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const isolationRoot = PATHS.APP_DIR
let tempAppDir: string
const originalFetch = globalThis.fetch
const originalApiKey = state.legacyApiKey

interface RecordedCall {
  url: string
  body: Record<string, unknown>
}

let calls: Array<RecordedCall>

function mockCompactFetch(resultBody: Record<string, unknown>) {
  const fetchMock = mock((url: unknown, init?: { body?: unknown }) => {
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    } catch {
      // leave empty
    }
    calls.push({ url: String(url), body: parsed })
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(resultBody),
      text: () => Promise.resolve(""),
      clone: () => ({
        text: () => Promise.resolve(""),
      }),
    }
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
}

const COMPACTION_RESULT = {
  id: "resp_compact_1",
  object: "response.compaction",
  model: "gpt-5.4",
  usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
  output: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "summary" }],
    },
  ],
}

const HISTORY_INPUT = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "history turn 1" }],
  },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "reply 1" }],
  },
]

async function setupCodexConnection() {
  await createConnection({
    id: "codex-compact",
    name: "codex-compact",
    protocol: "codex-native",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    priority: 0,
    credentials: [{ id: "codex-cred", value: "eJ-test", authMode: "bearer" }],
    models: [
      {
        publicId: "gpt-5.4",
        upstreamId: "gpt-5.4",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
}

async function setupXaiConnection() {
  await createConnection({
    id: "xai-compact",
    name: "xai-compact",
    protocol: "xai-native",
    baseUrl: "https://api.x.ai/v1",
    priority: 0,
    credentials: [
      { id: "xai-cred", value: "xai-test-token", authMode: "bearer" },
    ],
    models: [
      {
        publicId: "grok-4.6",
        upstreamId: "grok-4.6",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
}

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `compact-test-${randomUUID()}-`),
  )
  redirectPathsToDir(tempAppDir)
  __resetProviderConnectionsForTest()
  statsStore.clearUsageStatsForTest()
  resetProtectedRouteGuardForTest()
  state.legacyApiKey = undefined
  calls = []
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  redirectPathsToDir(isolationRoot)
  __resetProviderConnectionsForTest()
  state.legacyApiKey = originalApiKey
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

describe("POST /v1/responses/compact", () => {
  test("codex: forwards to upstream /responses/compact unary", async () => {
    await setupCodexConnection()
    mockCompactFetch(COMPACTION_RESULT)

    const response = await server.fetch(
      new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: HISTORY_INPUT,
          prompt_cache_key: "sess-1",
        }),
      }),
    )
    expect(response.status).toBe(200)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.object).toBe("response.compaction")
    expect(json.id).toBe("resp_compact_1")

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      "https://chatgpt.com/backend-api/codex/responses/compact",
    )
    expect(calls[0].body.model).toBe("gpt-5.4")
    expect(calls[0].body.stream).toBeUndefined()
    expect(calls[0].body.prompt_cache_key).toBe("sess-1")
    expect(calls[0].body.input).toEqual(HISTORY_INPUT)
  })

  test("rejects stream:true with 400", async () => {
    await setupCodexConnection()
    mockCompactFetch(COMPACTION_RESULT)

    const response = await server.fetch(
      new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          stream: true,
          input: HISTORY_INPUT,
        }),
      }),
    )
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test("xai: uses official API and strips inference params", async () => {
    await setupXaiConnection()
    mockCompactFetch({
      ...COMPACTION_RESULT,
      object: "response.compaction",
      model: "grok-4.6",
    })

    const response = await server.fetch(
      new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-4.6",
          input: HISTORY_INPUT,
          temperature: 0.7,
          top_p: 0.9,
          stop: ["END"],
          tools: [{ type: "function", name: "f" }],
          max_output_tokens: 100,
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    // compact 只存在于官方 API，绝不能打到 cli-chat-proxy。
    expect(calls[0].url).toBe("https://api.x.ai/v1/responses/compact")
    expect(calls[0].body.temperature).toBeUndefined()
    expect(calls[0].body.top_p).toBeUndefined()
    expect(calls[0].body.stop).toBeUndefined()
    expect(calls[0].body.tools).toBeUndefined()
    expect(calls[0].body.max_output_tokens).toBeUndefined()
    expect(calls[0].body.input).toEqual(HISTORY_INPUT)
  })

  test("unsupported protocol fails without polluting credential state", async () => {
    await createConnection({
      id: "chat-only",
      name: "chat-only",
      protocol: "openai-compatible",
      baseUrl: "https://example.com/v1",
      priority: 0,
      credentials: [{ id: "chat-cred", value: "sk-x", authMode: "bearer" }],
      models: [
        {
          publicId: "some-model",
          upstreamId: "some-model",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })
    mockCompactFetch(COMPACTION_RESULT)

    const response = await server.fetch(
      new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "some-model", input: HISTORY_INPUT }),
      }),
    )
    expect(response.status).not.toBe(200)
    expect(calls).toHaveLength(0)
    // 预过滤发生在执行之前：凭据不能被 markCooldown 污染。
    expect(getProviderConnection("chat-only")?.credentials[0].status).toBe(
      "ready",
    )
    expect(
      getProviderConnection("chat-only")?.credentials[0].cooldownUntil,
    ).toBeUndefined()
  })

  test("inline compaction_trigger in /responses is translated to compact", async () => {
    await setupCodexConnection()
    mockCompactFetch(COMPACTION_RESULT)

    const response = await server.fetch(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          stream: false,
          input: [...HISTORY_INPUT, { type: "compaction_trigger" }],
        }),
      }),
    )
    expect(response.status).toBe(200)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.object).toBe("response.compaction")

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      "https://chatgpt.com/backend-api/codex/responses/compact",
    )
    // trigger 已剥离，只剩历史。
    expect(calls[0].body.input).toEqual(HISTORY_INPUT)
  })
})
