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
