import { afterEach, beforeEach, expect, test } from "bun:test"

import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  setConnectionSetting,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const usage = {
  input_tokens: 1000,
  output_tokens: 70,
  total_tokens: 1070,
  input_tokens_details: { cached_tokens: 600 },
  output_tokens_details: { reasoning_tokens: 30 },
}

beforeEach(async () => {
  statsStore.clearUsageStatsForTest()
  resetProtectedRouteGuardForTest()
  resetAdaptiveRateLimiterForTest()
  __resetProviderConnectionsForTest()
  const connection = await createConnection({
    id: "codex-usage",
    name: "codex",
    protocol: "codex-native",
    baseUrl: "https://codex-usage.test/v1",
    credentials: [
      { id: "codex-credential", value: "fixture", authMode: "bearer" },
    ],
    models: [
      {
        publicId: "usage-model",
        upstreamId: "usage-model",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
  setConnectionSetting(connection, "baseUrl", "https://codex-usage.test/v1")
  statsStore.setModelPricing("usage-model", {
    promptPricePer1k: 1,
    completionPricePer1k: 2,
    cacheReadPricePer1k: 0.1,
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
  statsStore.clearUsageStatsForTest()
})

for (const endpoint of ["responses", "chat/completions", "messages"]) {
  for (const stream of [false, true]) {
    for (const status of ["completed", "incomplete", "failed"] as const) {
      test(`${endpoint} preserves Codex reported usage (${status}, stream=${stream})`, async () => {
        const terminal = {
          id: "resp_usage",
          object: "response",
          model: "usage-model",
          status,
          usage,
          output: [
            {
              type: "message",
              id: "msg_usage",
              role: "assistant",
              content: [{ type: "output_text", text: "answer" }],
            },
          ],
          ...(status === "incomplete" ?
            { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
          ...(status === "failed" ?
            { error: { type: "server_error", message: "fixture failure" } }
          : {}),
        }
        globalThis.fetch = (async () =>
          new Response(
            [
              {
                type: "response.created",
                response: {
                  id: "resp_usage",
                  model: "usage-model",
                  output: [],
                },
              },
              { type: `response.${status}`, response: terminal },
            ]
              .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
              .join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          )) as unknown as typeof fetch
        const response = await server.fetch(
          new Request(`http://localhost/v1/${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "usage-model",
              stream,
              ...(endpoint === "responses" ?
                { input: "hello" }
              : {
                  messages: [{ role: "user", content: "hello" }],
                  max_tokens: 70,
                }),
            }),
          }),
        )
        const body = await response.text()
        expect(response.status).toBe(status === "failed" && !stream ? 500 : 200)
        const stored = statsStore.getUsageStats("codex-usage")[0]
        expect(stored).toMatchObject({
          requests: status === "failed" && !stream ? 0 : 1,
          promptTokens: 400,
          completionTokens: 70,
          cacheReadTokens: 600,
          totalTokens: 1070,
        })
        expect(stored?.cost).toBeCloseTo(0.6, 10)
        if (stream && status === "incomplete") {
          expect(body).not.toContain('"type":"error"')
          expect(body).toContain(
            endpoint === "chat/completions" ? '"finish_reason":"length"'
            : endpoint === "messages" ? '"stop_reason":"max_tokens"'
            : '"type":"response.incomplete"',
          )
        }
        if (status === "failed") expect(body).toContain("fixture failure")
      })
    }
  }
}

test("nonstream failed usage is attributed once to the failed candidate, not its fallback", async () => {
  await createConnection({
    id: "fallback",
    name: "fallback",
    protocol: "openai-responses-compatible",
    priority: 100,
    baseUrl: "https://fallback.test/v1",
    credentials: [
      { id: "fallback-credential", value: "fixture", authMode: "bearer" },
    ],
    models: [
      {
        publicId: "usage-model",
        upstreamId: "usage-model",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
  globalThis.fetch = (async (url: unknown) => {
    const failed = String(url).includes("codex-usage.test")
    const response = {
      id: "resp_failover",
      object: "response",
      model: "usage-model",
      output: [],
      status: failed ? "failed" : "completed",
      usage:
        failed ? usage : (
          { input_tokens: 20, output_tokens: 3, total_tokens: 23 }
        ),
      ...(failed ?
        {
          error: { type: "server_error", message: "fixture failure" },
          service_tier: "priority",
        }
      : {}),
    }
    return failed ?
        new Response(
          `data: ${JSON.stringify({ type: "response.failed", response })}\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      : Response.json(response)
  }) as typeof fetch
  const response = await server.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "usage-model", input: "hello" }),
    }),
  )
  await response.text()
  expect(response.status).toBe(200)
  const failed = statsStore.getUsageStats("codex-usage")[0]
  const fallback = statsStore.getUsageStats("fallback")[0]
  expect(failed).toMatchObject({ requests: 0, totalTokens: 1070 })
  expect(failed?.cost).toBeCloseTo(1.2, 10)
  expect(fallback).toMatchObject({ requests: 1, totalTokens: 23 })
  expect(fallback?.cost).toBeCloseTo(0.026, 10)
})
