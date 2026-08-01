import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const originalFetch = globalThis.fetch

beforeEach(async () => {
  statsStore.clearUsageStatsForTest()
  resetProtectedRouteGuardForTest()
  __resetProviderConnectionsForTest()
  await createConnection({
    id: "anthropic-conn",
    name: "anthropic",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.anthropic.test",
    credentials: [{ id: "cred-1", value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: "claude-sonnet-4",
        upstreamId: "claude-sonnet-4",
        endpoints: ["messages"],
        enabled: true,
      },
    ],
  })
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
})

test("POST /v1/chat/completions routes to a messages-only connection via chat→messages translation", async () => {
  const fetchMock = mock(
    (
      url: string,
      opts: { body?: string; headers?: Record<string, string> },
    ) => ({
      ok: true,
      json: () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello from Claude" }],
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 5 },
      }),
      text: () => Promise.resolve(""),
      status: 200,
      headers: opts.headers ?? {},
      url,
    }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    choices: Array<{ message: { content: string }; finish_reason: string }>
  }
  expect(body.choices[0].message.content).toBe("Hello from Claude")
  expect(body.choices[0].finish_reason).toBe("stop")

  // Upstream must be hit at /v1/messages with the translated Anthropic payload.
  const [url, options] = fetchMock.mock.calls[0] as [string, { body?: string }]
  expect(url).toContain("/messages")
  const upstreamBody = JSON.parse(options.body ?? "{}") as {
    model: string
    max_tokens: number
    messages: Array<{ role: string; content: string }>
  }
  expect(upstreamBody.model).toBe("claude-sonnet-4")
  expect(upstreamBody.max_tokens).toBe(64000)
  expect(upstreamBody.messages).toEqual([{ role: "user", content: "hi" }])
})

test("POST /v1/chat/completions streaming translates Anthropic SSE to OpenAI chunks", async () => {
  const fetchMock = mock(
    (_url: string) =>
      new Response(
        [
          'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
          "",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          "",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Claude"}}',
          "",
          'data: {"type":"content_block_stop","index":0}',
          "",
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":3,"output_tokens":5}}',
          "",
          'data: {"type":"message_stop"}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    }),
  )

  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).toContain("chat.completion.chunk")
  expect(text).toContain("Hello from Claude")
  // The route consumes the upstream [DONE] and closes the stream (matching
  // the native chat path), so [DONE] itself is not forwarded to the client.
  const [url] = fetchMock.mock.calls[0] as [string]
  expect(url).toContain("/messages")
})
