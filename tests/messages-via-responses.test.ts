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
    id: "responses-conn",
    name: "responses",
    protocol: "openai-responses-compatible",
    baseUrl: "https://api.responses.test/v1",
    credentials: [{ id: "cred-1", value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: "gpt-responses",
        upstreamId: "gpt-responses",
        endpoints: ["responses"],
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

test("POST /v1/messages routes to a responses-only connection via messages→responses translation", async () => {
  const fetchMock = mock((url: string) => ({
    ok: true,
    json: () => ({
      id: "resp_1",
      object: "response",
      model: "gpt-responses",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from responses" }],
        },
      ],
      output_text: "Hello from responses",
      usage: { input_tokens: 3, output_tokens: 5 },
    }),
    text: () => Promise.resolve(""),
    status: 200,
    url,
    headers: {},
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-responses",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const [url, options] = fetchMock.mock.calls[0] as unknown as [
    string,
    { body?: string },
  ]
  expect(url).toContain("/responses")
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "gpt-responses",
    max_output_tokens: 256,
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  })

  const body = (await response.json()) as {
    type: string
    content: Array<{ type: string; text?: string }>
  }
  expect(body.type).toBe("message")
  expect(body.content).toEqual([{ type: "text", text: "Hello from responses" }])
})
