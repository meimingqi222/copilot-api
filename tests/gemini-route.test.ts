import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { logStore } from "~/lib/log-store"
import { clearTraceBusForTest, recentTraces } from "~/lib/trace-bus"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const originalFetch = globalThis.fetch

function geminiResponse(text: string) {
  return {
    responseId: "resp_1",
    modelVersion: "gemini-3-pro",
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 4,
      candidatesTokenCount: 6,
      totalTokenCount: 10,
    },
  }
}

beforeEach(async () => {
  logStore.clearForTest()
  clearTraceBusForTest()
  statsStore.clearUsageStatsForTest()
  resetProtectedRouteGuardForTest()
  __resetProviderConnectionsForTest()
})

afterEach(() => {
  logStore.clearForTest()
  clearTraceBusForTest()
  statsStore.clearUsageStatsForTest()
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
})

test("POST /v1beta/models/{model}:generateContent hits a gemini-compatible upstream", async () => {
  await createConnection({
    id: "gemini-conn",
    name: "gemini",
    protocol: "gemini-compatible",
    baseUrl: "https://generativelanguage.test/v1beta",
    credentials: [{ id: "cred-1", value: "key-1", authMode: "bearer" }],
    models: [
      {
        publicId: "gemini-3-pro",
        upstreamId: "gemini-3-pro",
        endpoints: ["gemini"],
        enabled: true,
      },
    ],
  })

  const fetchMock = mock((url: string) => ({
    ok: true,
    json: () => geminiResponse("Hello from Gemini"),
    text: () => Promise.resolve(""),
    status: 200,
    url,
    headers: {},
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1beta/models/gemini-3-pro:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        systemInstruction: { parts: [{ text: "be brief" }] },
      }),
    }),
  )

  expect(response.status).toBe(200)
  const [url, options] = fetchMock.mock.calls[0] as unknown as [
    string,
    { body?: string; method?: string },
  ]
  expect(url).toBe(
    "https://generativelanguage.test/v1beta/models/gemini-3-pro:generateContent",
  )
  expect(options.method).toBe("POST")
  const upstreamBody = JSON.parse(options.body ?? "{}") as {
    contents: Array<{ role: string; parts: Array<{ text: string }> }>
    systemInstruction: { parts: Array<{ text: string }> }
  }
  expect(upstreamBody.systemInstruction.parts[0].text).toBe("be brief")
  expect(upstreamBody.contents[0]).toEqual({
    role: "user",
    parts: [{ text: "hi" }],
  })

  const body = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>
  }
  expect(body.candidates[0].content.parts).toEqual([
    { text: "Hello from Gemini" },
  ])
})

test("streamGenerateContent forwards SSE frames and appends alt=sse", async () => {
  await createConnection({
    id: "gemini-conn",
    name: "gemini",
    protocol: "gemini-compatible",
    baseUrl: "https://generativelanguage.test/v1beta",
    credentials: [{ id: "cred-1", value: "key-1", authMode: "bearer" }],
    models: [
      {
        publicId: "gemini-3-pro",
        upstreamId: "gemini-3-pro",
        endpoints: ["gemini"],
        enabled: true,
      },
    ],
  })

  const chunks = [
    {
      candidates: [
        { index: 0, content: { role: "model", parts: [{ text: "He" }] } },
      ],
    },
    {
      candidates: [
        { index: 0, content: { role: "model", parts: [{ text: "llo" }] } },
      ],
    },
    { candidates: [{ index: 0, finishReason: "STOP" }] },
  ]
  const fetchMock = mock((url: string) => ({
    ok: true,
    status: 200,
    url,
    headers: {},
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          )
        }
        controller.close()
      },
    }),
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request(
      "http://localhost/v1beta/models/gemini-3-pro:streamGenerateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.78",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    ),
  )

  expect(response.status).toBe(200)
  const url = fetchMock.mock.calls[0]?.[0] as unknown as string
  expect(url).toContain(":streamGenerateContent?alt=sse")

  const text = await response.text()
  const frames = text
    .split("\n\n")
    .map((line) => line.replace(/^data: /, "").trim())
    .filter((line) => line.startsWith("{"))
    .map(
      (line) =>
        JSON.parse(line) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        },
    )
  const emitted = frames
    .flatMap((frame) => frame.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text)
    .filter(Boolean)
  expect(emitted).toEqual(["He", "llo"])
  const requestId = response.headers.get("X-Request-Id")
  const trace = recentTraces().find((record) => record.requestId === requestId)
  expect(trace?.inFlight).toBe(false)
  expect(trace?.outcome).toBe("success")
  expect(
    logStore.query({ requestId: requestId ?? undefined }).entries,
  ).toHaveLength(1)
})

test("a Gemini client falls back to a chat-only connection via the shared codec table", async () => {
  await createConnection({
    id: "openai-conn",
    name: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://openai.test/v1",
    credentials: [{ id: "cred-1", value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: "shared-model",
        upstreamId: "shared-model",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
  })

  const fetchMock = mock((url: string) => ({
    ok: true,
    json: () => ({
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 1,
      model: "shared-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "translated" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    text: () => Promise.resolve(""),
    status: 200,
    url,
    headers: {},
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1beta/models/shared-model:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const url = fetchMock.mock.calls[0]?.[0] as unknown as string
  expect(url).toContain("/chat/completions")
  const body = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>
  }
  expect(body.candidates[0].content.parts).toEqual([{ text: "translated" }])
})

test("rejects an unknown Gemini action with 404", async () => {
  const response = await server.fetch(
    new Request("http://localhost/v1beta/models/gemini-3-pro:countTokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    }),
  )
  expect(response.status).toBe(404)
})
