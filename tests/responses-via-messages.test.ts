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
