/**
 * Requests / 请求追踪: the trace bus and the admin trace API.
 *
 * The live view is fed by a short ring buffer + subscriber set (trace-bus.ts)
 * that the request-log middleware publishes to after the entry lands in
 * logStore. These tests pin the two things the view depends on: the buffer
 * shape/ordering and the API projecting a finalized request into a frame.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  bindRequestLogContext,
  createDetachedRequestLog,
  markTraceFirstOutput,
} from "~/lib/request-log"

import { logStore } from "~/lib/log-store"
import type { RequestLogRecord } from "~/lib/log-store"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { clearRecentServeForTest } from "~/lib/route-target"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import {
  clearTraceBusForTest,
  publishTrace,
  recentTraces,
  subscribeTrace,
  TRACE_KEEP,
  type TraceInput,
} from "~/lib/trace-bus"

import {
  adminRequest,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"

const originalAdminPassword = state.adminPassword
const originalLegacyApiKey = state.legacyApiKey
const originalFetch = globalThis.fetch

beforeEach(() => {
  clearTraceBusForTest()
  clearRecentServeForTest()
  statsStore.clearUsageStatsForTest()
  resetProtectedRouteGuardForTest()
  __resetProviderConnectionsForTest()
  state.adminPassword = undefined
  state.legacyApiKey = undefined
  clearAdminPasswordConfig()
  setupAdminAuth()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearTraceBusForTest()
  logStore.clearForTest()
  __resetProviderConnectionsForTest()
  state.adminPassword = originalAdminPassword
  state.legacyApiKey = originalLegacyApiKey
  clearAdminAuth()
  clearAdminPasswordConfig()
})

function frame(
  overrides: Partial<RequestLogRecord> & { requestId: string },
): RequestLogRecord & { requestId: string } {
  return {
    timestamp: Date.now(),
    level: "info",
    message: "POST /v1/chat/completions 200",
    outcome: "success",
    ...overrides,
  }
}

describe("trace bus", () => {
  test("first semantic output publishes once while a stream is still running", async () => {
    const app = new Hono()
    const events: Array<TraceInput> = []
    const unsubscribe = subscribeTrace(({ entry }) => events.push(entry))
    app.get("/", (c) => {
      const ctx = createDetachedRequestLog({
        requestId: "output",
        streaming: true,
      })
      bindRequestLogContext(c, ctx)
      markTraceFirstOutput(c, 120)
      markTraceFirstOutput(c, 180)
      return c.text("ok")
    })
    await app.request("/")
    unsubscribe()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      requestId: "output",
      ttftMs: 120,
      inFlight: true,
      outputObserved: true,
    })
  })
  test("concurrent updates publish the updated request with its merged fields", () => {
    publishTrace({ requestId: "older", model: "kept-model" }, "start")
    publishTrace({ requestId: "newer" }, "start")
    const seen: Array<TraceInput> = []
    const unsubscribe = subscribeTrace(({ entry }) => seen.push(entry))
    publishTrace({ requestId: "older", connectionName: "chosen" }, "update")
    publishTrace({ requestId: "older", latencyMs: 42 }, "final")
    unsubscribe()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({
      requestId: "older",
      model: "kept-model",
      connectionName: "chosen",
      inFlight: true,
    })
    expect(seen[1]).toMatchObject({
      requestId: "older",
      model: "kept-model",
      latencyMs: 42,
      inFlight: false,
    })
  })

  test("keeps the most recent traces, oldest first, bounded by TRACE_KEEP", () => {
    for (let i = 0; i < TRACE_KEEP + 10; i++) {
      publishTrace(frame({ requestId: `req-${i}` }))
    }
    const recent = recentTraces(TRACE_KEEP + 50)
    expect(recent).toHaveLength(TRACE_KEEP)
    // Oldest of the kept window is the 10th published (the first 10 were dropped).
    expect(recent[0]?.requestId).toBe("req-10")
    expect(recent.at(-1)?.requestId).toBe(`req-${TRACE_KEEP + 9}`)
  })

  test("recentTraces honours a smaller limit but never exceeds the window", () => {
    for (let i = 0; i < 5; i++) {
      publishTrace(frame({ requestId: `req-${i}` }))
    }
    expect(recentTraces(2).map((r) => r.requestId)).toEqual(["req-3", "req-4"])
    expect(recentTraces(999)).toHaveLength(5)
  })

  test("subscribers receive each published trace until they unsubscribe", () => {
    const seen: Array<string | undefined> = []
    const unsubscribe = subscribeTrace(({ entry }) =>
      seen.push(entry.requestId),
    )

    publishTrace(frame({ requestId: "a" }))
    publishTrace(frame({ requestId: "b" }))
    unsubscribe()
    publishTrace(frame({ requestId: "c" }))

    expect(seen).toEqual(["a", "b"])
  })

  test("start/update upsert in place; final settles the same record", () => {
    const phases: Array<string> = []
    const unsubscribe = subscribeTrace(({ entry, phase }) => {
      phases.push(phase)
      expect(entry.requestId).toBe("live")
    })

    publishTrace(frame({ requestId: "live" }), "start")
    publishTrace(frame({ requestId: "live", model: "m" }), "update")
    publishTrace(
      frame({ requestId: "live", model: "m", latencyMs: 42 }),
      "final",
    )
    unsubscribe()

    // One record, not three — the later phases refine the earlier ones.
    expect(recentTraces()).toHaveLength(1)
    expect(recentTraces()[0]?.model).toBe("m")
    expect(recentTraces()[0]?.latencyMs).toBe(42)
    expect(recentTraces()[0]?.inFlight).toBe(false)
    expect(phases).toEqual(["start", "update", "final"])
  })

  test("a non-final phase marks the record in flight", () => {
    publishTrace(frame({ requestId: "r" }), "start")
    expect(recentTraces()[0]?.inFlight).toBe(true)
    publishTrace(frame({ requestId: "r" }), "final")
    expect(recentTraces()[0]?.inFlight).toBe(false)
  })
})

describe("GET /admin/api/trace/recent", () => {
  test("requires admin role", async () => {
    clearAdminAuth()
    const response = await server.fetch(
      new Request("http://localhost/admin/api/trace/recent"),
    )
    expect(response.status).toBe(403)
  })

  test("shows a request while it is still in flight", async () => {
    await createConnection({
      id: "live-conn",
      name: "live-upstream",
      protocol: "openai-compatible",
      baseUrl: "https://upstream.test/v1",
      credentials: [{ id: "live-cred", value: "sk-x", authMode: "bearer" }],
      models: [
        {
          publicId: "live-model",
          upstreamId: "live-model",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })

    const original = globalThis.fetch
    // Upstream that stalls well past the mid-flight probe below.
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(
              new Response(
                `data: ${JSON.stringify({
                  id: "c",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "live-model",
                  choices: [
                    {
                      index: 0,
                      delta: { content: "hi" },
                      finish_reason: "stop",
                    },
                  ],
                })}\n\ndata: [DONE]\n\n`,
                {
                  status: 200,
                  headers: { "content-type": "text/event-stream" },
                },
              ),
            )
          }, 400)
        }),
    ) as unknown as typeof fetch

    // Fire and don't await — it is in flight while we probe.
    const pending = server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "live-model",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )

    await new Promise((r) => setTimeout(r, 150))

    const midFlight = (await (
      await server.fetch(
        adminRequest("http://localhost/admin/api/trace/recent"),
      )
    ).json()) as { traces: Array<Record<string, unknown>> }
    const live = midFlight.traces.at(-1)
    expect(live).toBeDefined()
    expect(live?.inFlight).toBe(true)
    // Routing already resolved, so the connection is visible before the reply.
    expect(live?.connectionName).toBe("live-upstream")
    const requestId = live?.requestId

    const response = await pending
    await response.text()

    const settled = (await (
      await server.fetch(
        adminRequest("http://localhost/admin/api/trace/recent"),
      )
    ).json()) as { traces: Array<Record<string, unknown>> }
    const done = settled.traces.find((t) => t.requestId === requestId)
    expect(done?.inFlight).toBe(false)
    expect(done?.outcome).toBe("success")

    globalThis.fetch = original
  })

  test("projects a finalized request into a trace frame", async () => {
    const conn = await createConnection({
      id: "trace-conn",
      name: "trace-upstream",
      protocol: "openai-compatible",
      baseUrl: "https://upstream.test/v1",
      credentials: [{ id: "trace-cred", value: "sk-x", authMode: "bearer" }],
      models: [
        {
          publicId: "trace-model",
          upstreamId: "trace-model",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })
    // Route evidence: 42% of the chat window used, renewing in a day.
    const credential = conn.credentials[0]
    if (credential) {
      credential.quota = {
        fetchedAt: Date.now(),
        chatRemaining: 58,
        chatTotal: 100,
        unlimited: false,
        details: { resetsAt: Math.floor(Date.now() / 1000) + 86400 },
      }
    }

    const body = JSON.stringify({
      id: "chatcmpl_trace",
      object: "chat.completion.chunk",
      created: 1,
      model: "trace-model",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(`data: ${body}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ) as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "trace-model",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )
    expect(response.status).toBe(200)
    // Drain so the stream producer finalizes the request log.
    await response.text()

    const apiResponse = await server.fetch(
      adminRequest("http://localhost/admin/api/trace/recent"),
    )
    expect(apiResponse.status).toBe(200)
    const payload = (await apiResponse.json()) as {
      traces: Array<Record<string, unknown>>
      keep: number
    }
    expect(payload.keep).toBe(TRACE_KEEP)
    const trace = payload.traces.find((t) => t.model === "trace-model")
    expect(trace).toBeDefined()
    expect(trace).toMatchObject({
      endpoint: "chat",
      outcome: "success",
      connectionName: "trace-upstream",
      credentialId: "trace-cred",
    })
    // Candidate paths are projected, chosen one first, with route evidence.
    const candidates = trace?.candidates as Array<Record<string, unknown>>
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0]).toMatchObject({
      connectionName: "trace-upstream",
      status: "chosen",
      why: "chosen",
      quotaUsedPct: 42,
      servedTokens: 0,
    })
    expect(candidates[0]?.renewAtMs).toBeGreaterThan(Date.now())
    // The frame carries timing, not the full diagnostic entry.
    expect("ttftMs" in (trace ?? {})).toBe(true)
    expect("message" in (trace ?? {})).toBe(false)
  })
})

describe("GET /admin/api/trace/history", () => {
  test("requires admin role", async () => {
    clearAdminAuth()
    const response = await server.fetch(
      new Request("http://localhost/admin/api/trace/history"),
    )
    expect(response.status).toBe(403)
  })

  test("merges persisted history and finalized memory records, filters dates and deduplicates", async () => {
    const originalLogDir = process.env.LOG_DIR
    const root = resolve("temp")
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, "trace-history-"))
    process.env.LOG_DIR = directory
    const timestamp = new Date("2026-10-01T12:00:00Z").getTime()
    const kept = {
      ...frame({ requestId: "persisted", timestamp, model: "history-model" }),
      id: 1,
    }
    try {
      await writeFile(
        join(directory, "requests-2026-10-01.jsonl"),
        JSON.stringify(kept) + "\n",
      )
      logStore.push({ ...kept, connectionName: "memory-wins" })
      logStore.push(
        frame({ requestId: "memory-only", timestamp: timestamp + 1 }),
      )
      logStore.push(frame({ requestId: "outside", timestamp: timestamp - 100 }))
      publishTrace({ requestId: "still-running", timestamp }, "start")
      const response = await server.fetch(
        adminRequest(
          `http://localhost/admin/api/trace/history?timeFrom=${timestamp}&timeTo=${timestamp + 50}`,
        ),
      )
      const data = (await response.json()) as {
        traces: Array<Record<string, unknown>>
      }
      expect(data.traces.map((t) => t.requestId)).toEqual([
        "persisted",
        "memory-only",
      ])
      expect(data.traces[0]).toMatchObject({
        connectionName: "memory-wins",
        model: "history-model",
        inFlight: false,
      })
      expect(data.traces[0]).not.toHaveProperty("message")
      logStore.clearForTest()
      const persistedResponse = await server.fetch(
        adminRequest(
          `http://localhost/admin/api/trace/history?timeFrom=${timestamp}`,
        ),
      )
      const persistedData = (await persistedResponse.json()) as {
        traces: Array<Record<string, unknown>>
      }
      expect(persistedData.traces).toHaveLength(1)
      expect(persistedData.traces[0]?.requestId).toBe("persisted")
    } finally {
      if (originalLogDir === undefined) delete process.env.LOG_DIR
      else process.env.LOG_DIR = originalLogDir
      if (directory.startsWith(root + "\\"))
        await rm(directory, { recursive: true, force: true })
    }
  })
})
