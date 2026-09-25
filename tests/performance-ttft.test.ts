/**
 * Performance metrics (TTFT / TPS) must be measured from BEFORE the upstream
 * dispatch, not from the moment the downstream SSE callback opens.
 *
 * Regression: commit 4b5141f ("Phase 1") moved dispatch out of the SSE callback
 * so pre-first-chunk failures can return a real HTTP status. The `streamStart`
 * clock was left behind inside the callback, so it was captured only after
 * dispatch had already resolved (upstream connect + TTFB done). TTFT then
 * measured downstream-open → first chunk (near zero) and TPS used a denominator
 * that excluded the whole upstream wait (inflated).
 *
 * The upstream delay below lives in `fetch` resolution, i.e. before the
 * response body exists, which is exactly the window the old code skipped.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const UPSTREAM_DELAY_MS = 150

function sseBody(): string {
  return [
    `data: ${JSON.stringify({
      id: "chatcmpl_perf",
      object: "chat.completion.chunk",
      created: 1,
      model: "perf-test-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl_perf",
      object: "chat.completion.chunk",
      created: 1,
      model: "perf-test-model",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl_perf",
      object: "chat.completion.chunk",
      created: 1,
      model: "perf-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")
}

/** Upstream that stalls for `delayMs` BEFORE returning the SSE response. */
function delayedUpstream(delayMs: number): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(
        new Response(sseBody(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }, delayMs)
  })
}

describe("performance TTFT/TPS capture point", () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    statsStore.clearUsageStatsForTest()
    resetProtectedRouteGuardForTest()
    __resetProviderConnectionsForTest()
    await createConnection({
      id: "perf-conn",
      name: "perf",
      protocol: "openai-compatible",
      baseUrl: "https://upstream.test/v1",
      credentials: [{ id: "perf-cred", value: "sk-test", authMode: "bearer" }],
      models: [
        {
          publicId: "perf-test-model",
          upstreamId: "perf-test-model",
          endpoints: ["chat"],
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

  test("streaming TTFT includes the upstream dispatch wait", async () => {
    globalThis.fetch = mock(() =>
      delayedUpstream(UPSTREAM_DELAY_MS),
    ) as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "perf-test-model",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    // Drain the SSE stream so the usage row is written in `finally`.
    await response.text()

    const perf = statsStore.getPerformanceByModelInRange({
      startMs: 0,
      endMs: Date.now() + 60_000,
    })
    const row = perf.find((entry) => entry.model === "perf-test-model")
    expect(row).toBeDefined()
    // The old bug captured streamStart after the stall, yielding ~0ms here.
    expect(row?.avgTtftMs).toBeGreaterThanOrEqual(UPSTREAM_DELAY_MS - 30)
  })

  test("streaming TPS denominator covers the full upstream round trip", async () => {
    globalThis.fetch = mock(() =>
      delayedUpstream(UPSTREAM_DELAY_MS),
    ) as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "perf-test-model",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )
    await response.text()

    const perf = statsStore.getPerformanceByModelInRange({
      startMs: 0,
      endMs: Date.now() + 60_000,
    })
    const row = perf.find((entry) => entry.model === "perf-test-model")
    expect(row).toBeDefined()
    // 5 completion tokens over a >=150ms window cannot exceed ~33 tok/s.
    // The old denominator skipped the stall and reported a much higher rate.
    expect(row?.avgStreamingTps).not.toBeNull()
    expect(row?.avgStreamingTps ?? Infinity).toBeLessThan(50)
  })
})
