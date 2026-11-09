import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  updateConnection,
} from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import {
  getTranslationLossMetricsSnapshot,
  resetTranslationLossMetricsForTest,
} from "~/services/ir"

const originalFetch = globalThis.fetch

beforeEach(async () => {
  statsStore.clearUsageStatsForTest()
  resetTranslationLossMetricsForTest()
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

test.each(
  ["chat", "responses"].flatMap((wire) =>
    [false, true].flatMap((stream) =>
      [false, true].map((deepseek) => ({ wire, stream, deepseek })),
    ),
  ),
)(
  "$wire → Messages replays unsigned thinking only for DeepSeek (stream=$stream deepseek=$deepseek)",
  async ({ wire, stream, deepseek }) => {
    if (deepseek)
      await updateConnection("anthropic-conn", {
        baseUrl: "https://api.deepseek.com/anthropic",
        models: [
          {
            publicId: "claude-sonnet-4",
            upstreamId: "deepseek-flash",
            endpoints: ["messages"],
            enabled: true,
          },
        ],
      })
    let sent: Record<string, unknown> | undefined
    const message = {
      id: "msg_done",
      type: "message",
      role: "assistant",
      model: "deepseek-flash",
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 1 },
    }
    globalThis.fetch = mock((_url: unknown, options?: RequestInit) => {
      sent = JSON.parse(String(options?.body)) as Record<string, unknown>
      if (!stream) return Promise.resolve(Response.json(message))
      const events = [
        {
          type: "message_start",
          message: { ...message, content: [], stop_reason: null },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "answer" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: message.usage,
        },
        { type: "message_stop" },
      ]
      return Promise.resolve(
        new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    }) as unknown as typeof fetch
    const response = await server.request(
      wire === "chat" ? "/v1/chat/completions" : "/v1/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4",
          stream,
          ...(wire === "chat" ?
            {
              messages: [
                { role: "user", content: "inspect" },
                {
                  role: "assistant",
                  content: "checking",
                  reasoning_content: "thought A",
                  tool_calls: [
                    {
                      id: "call_a",
                      type: "function",
                      function: { name: "read", arguments: "{}" },
                    },
                  ],
                },
                { role: "tool", tool_call_id: "call_a", content: "data A" },
                {
                  role: "assistant",
                  content: null,
                  reasoning_content: "thought B",
                  tool_calls: [
                    {
                      id: "call_b",
                      type: "function",
                      function: { name: "read", arguments: "{}" },
                    },
                  ],
                },
                { role: "tool", tool_call_id: "call_b", content: "data B" },
              ],
              tools: [
                {
                  type: "function",
                  function: { name: "read", parameters: { type: "object" } },
                },
              ],
            }
          : {
              input: [
                { role: "user", content: "inspect" },
                {
                  type: "reasoning",
                  summary: [{ type: "summary_text", text: "thought A" }],
                },
                {
                  role: "assistant",
                  content: [{ type: "output_text", text: "checking" }],
                },
                {
                  type: "function_call",
                  call_id: "call_a",
                  name: "read",
                  arguments: "{}",
                },
                {
                  type: "function_call_output",
                  call_id: "call_a",
                  output: "data A",
                },
                {
                  type: "reasoning",
                  summary: [],
                  content: [{ type: "reasoning_text", text: "thought B" }],
                },
                {
                  type: "function_call",
                  call_id: "call_b",
                  name: "read",
                  arguments: "{}",
                },
                {
                  type: "function_call_output",
                  call_id: "call_b",
                  output: "data B",
                },
              ],
              tools: [
                {
                  type: "function",
                  name: "read",
                  parameters: { type: "object" },
                },
              ],
            }),
        }),
      },
    )
    expect(response.status).toBe(200)
    const messages = sent?.messages as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>
    const assistants = messages.filter(
      (message) => message.role === "assistant",
    )
    expect(
      assistants.map((message) =>
        message.content.filter((part) => part.type === "thinking"),
      ),
    ).toEqual(
      deepseek ?
        [
          [{ type: "thinking", thinking: "thought A" }],
          [{ type: "thinking", thinking: "thought B" }],
        ]
      : [[], []],
    )
    expect(
      assistants.map((message) =>
        message.content.filter((part) => part.type === "tool_use"),
      ),
    ).toEqual([
      [
        expect.objectContaining({
          type: "tool_use",
          id: "call_a",
          name: "read",
          input: {},
        }),
      ],
      [
        expect.objectContaining({
          type: "tool_use",
          id: "call_b",
          name: "read",
          input: {},
        }),
      ],
    ])
    expect(
      messages.flatMap((message) =>
        Array.isArray(message.content) ?
          message.content
            .filter((part) => part.type === "tool_result")
            .map((part) => part.tool_use_id)
        : [],
      ),
    ).toEqual(["call_a", "call_b"])
    if (deepseek)
      expect(
        getTranslationLossMetricsSnapshot().filter(
          (loss) => loss.reason === "unsigned_thinking_dropped",
        ),
      ).toEqual([])
    const result = await response.text()
    expect(result).toContain("answer")
    expect(result).not.toContain("thought A")
    expect(result).not.toContain("thought B")
  },
)

test("POST /v1/responses routes to a messages-only connection via responses→messages translation", async () => {
  const fetchMock = mock((url: string) => ({
    ok: true,
    json: () => ({
      id: "msg_1",
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
    url,
    headers: {},
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", input: "hi" }),
    }),
  )

  expect(response.status).toBe(200)
  const [url, options] = fetchMock.mock.calls[0] as unknown as [
    string,
    { body?: string },
  ]
  expect(url).toContain("/messages")
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "claude-sonnet-4",
  })

  const body = (await response.json()) as {
    object: string
    output_text?: string
  }
  expect(body.object).toBe("response")
  expect(body.output_text).toBe("Hello from Claude")
})

for (const endpoint of ["responses", "chat/completions"]) {
  for (const lateInput of [false, true]) {
    test(`${endpoint} retains split Messages stream usage (late input=${lateInput})`, async () => {
      statsStore.setModelPricing("claude-sonnet-4", {
        promptPricePer1k: 1,
        completionPricePer1k: 2,
        cacheReadPricePer1k: 0.1,
        cacheWritePricePer1k: 1.25,
      })
      const cache = {
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 200,
        cache_creation: {
          ephemeral_5m_input_tokens: 50,
          ephemeral_1h_input_tokens: 150,
        },
      }
      const frames = [
        {
          type: "message_start",
          message: {
            id: "msg_split",
            model: "claude-sonnet-4",
            role: "assistant",
            content: [],
            usage: {
              input_tokens: lateInput ? 0 : 120,
              output_tokens: 0,
              ...cache,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            output_tokens: 70,
            ...(lateInput ? { input_tokens: 120 } : {}),
          },
        },
        { type: "message_stop" },
      ]
      globalThis.fetch = (async () =>
        new Response(
          frames
            .map(
              (frame) =>
                `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch
      const response = await server.fetch(
        new Request(`http://localhost/v1/${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4",
            stream: true,
            ...(endpoint === "responses" ?
              { input: "hi" }
            : { messages: [{ role: "user", content: "hi" }] }),
          }),
        }),
      )
      expect(response.status).toBe(200)
      const text = await response.text()
      const data = text
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)))
      if (endpoint === "responses") {
        expect(
          data.findLast((frame) => frame.type === "response.completed")
            ?.response.usage,
        ).toMatchObject({
          input_tokens: 920,
          output_tokens: 70,
          total_tokens: 990,
          input_tokens_details: {
            cached_tokens: 600,
            cache_creation_input_tokens: 200,
            cache_creation: { ephemeral_1h_input_tokens: 150 },
          },
        })
      } else {
        expect(data.findLast((frame) => frame.usage)?.usage).toMatchObject({
          prompt_tokens: 920,
          completion_tokens: 70,
          total_tokens: 990,
          prompt_tokens_details: {
            cached_tokens: 600,
            cache_creation_input_tokens: 200,
            cache_creation: { ephemeral_1h_input_tokens: 150 },
          },
        })
      }
      expect(statsStore.getUsageStats("anthropic-conn")[0]).toMatchObject({
        requests: 1,
        promptTokens: 120,
        completionTokens: 70,
        cacheReadTokens: 600,
        cacheWriteTokens: 200,
        totalTokens: 990,
      })
    })
  }
}
