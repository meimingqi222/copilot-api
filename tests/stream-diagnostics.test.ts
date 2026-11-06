import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Hono, type Context } from "hono"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { initRequestLog } from "~/lib/request-log"
import {
  attachPerformanceStream,
  writeSseEvent,
  writeSseEvents,
} from "~/lib/sse"
import {
  beginStreamDiagnostics,
  observeDownstreamEvent,
  StreamDiagnostics,
  withStreamDiagnosticAttempt,
} from "~/lib/stream-diagnostics"
import {
  listStreamIncidents,
  readStreamIncident,
} from "~/lib/stream-diagnostics-store"
import { safeSseStream } from "~/services/protocols/shared"
import { serializeUpstreamBody } from "~/lib/upstream-performance"
import { pumpWithLeadingBuffer } from "~/routes/responses/ws-pump"
import { logApiRoutes } from "~/routes/admin/api/logs"
import * as systemConfig from "~/lib/system-config"
import {
  clearUpstreamWebsocketSessionsForTest,
  openUpstreamResponsesWebsocketTurn,
} from "~/services/responses/upstream-ws"

interface Incident {
  reasons: string[]
  requestsTruncated: boolean
  streams: Array<{
    stage: string
    terminal: boolean
    events: number
    textBytes: number
    textHash: string
    droppedFrames: number
    framesOmittedForSecrets: boolean
    frames: Array<{
      wireData: { text: string; bytes: number; truncated: boolean }
    }>
  }>
  requests: Array<{ body: { text: string; truncated: boolean } }>
}

const phrase =
  "正在核对 grok-build 的定价查找路径，以及 DimAgent 如何解析该模型的用量。"
const isolationRoot = PATHS.APP_DIR
let root: string
let recorders: StreamDiagnostics[] = []
let originalEnabled: string | undefined

function recorder(): StreamDiagnostics {
  const result = new StreamDiagnostics(randomUUID(), "/v1/chat/completions")
  recorders.push(result)
  return result
}

function data(value: unknown) {
  return { data: JSON.stringify(value) }
}
function delta(text: string) {
  return data({
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })
}
const done = data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })

async function incident(record: StreamDiagnostics): Promise<Incident> {
  const value = await readStreamIncident(record.requestId)
  expect(value).toBeDefined()
  return value as unknown as Incident
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(os.tmpdir(), "stream-diagnostics-test-"))
  redirectPathsToDir(root)
  originalEnabled = process.env.STREAM_DIAGNOSTICS
  delete process.env.STREAM_DIAGNOSTICS
})

afterEach(async () => {
  await Promise.all(recorders.map((entry) => entry.finish("cancelled")))
  recorders = []
  if (originalEnabled === undefined) delete process.env.STREAM_DIAGNOSTICS
  else process.env.STREAM_DIAGNOSTICS = originalEnabled
  // Drain serialized writes/reads before restoring PATHS or removing fixtures.
  await listStreamIncidents()
  redirectPathsToDir(isolationRoot)
  await fs.rm(root, { recursive: true, force: true })
})

describe("stream flight recorder", () => {
  test("retains an ongoing loop without waiting for EOF; arbitrary chunk boundaries do not hide repetition", async () => {
    const record = recorder()
    const source = phrase.repeat(20)
    for (let index = 0; index < source.length; index += 7)
      record.observe("downstream", delta(source.slice(index, index + 7)))
    // Reads queue after the immediate trigger write; no explicit finish yet.
    const live = await incident(record)
    expect(live.reasons).toContain("repetition:downstream")
    record.observe("downstream", done)
    await record.finish()
    const final = await incident(record)
    expect(final.streams[0].textBytes).toBe(Buffer.byteLength(source))
    expect(final.streams[0].textHash).toBe(
      createHash("sha256").update(source).digest("hex"),
    )
    expect(final.streams[0].terminal).toBe(true)
  })

  test("normal, short repeated, and cancelled partial streams do not create incidents", async () => {
    for (const [text, cancelled] of [
      ["A normal answer with asymmetric details", false],
      [phrase.repeat(2), false],
      ["partial", true],
    ] as const) {
      const record = recorder()
      record.observe("downstream", delta(text))
      if (!cancelled) record.observe("downstream", done)
      await record.finish(cancelled ? "cancelled" : "completed")
      expect(await readStreamIncident(record.requestId)).toBeUndefined()
    }
  })

  test("captures abrupt EOF and protocol failures, preserving errors as data", async () => {
    const record = recorder()
    record.observe("downstream", delta("partial"))
    await record.finish()
    expect((await incident(record)).reasons).toEqual(["missing_terminal"])
    const failed = recorder()
    failed.observe(
      "downstream",
      data({
        type: "response.failed",
        response: { error: { message: "provider failed" } },
      }),
    )
    await failed.finish("failed")
    expect((await incident(failed)).reasons).toEqual([
      "error_event",
      "stream_failed",
    ])
  })

  test("a partial tool JSON is anomalous only on an otherwise complete turn", async () => {
    for (const terminal of ["tool_calls", "length"] as const) {
      const record = recorder()
      record.observe(
        "downstream",
        data({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 2, function: { arguments: '{"path":' } }],
              },
            },
          ],
        }),
      )
      record.observe(
        "downstream",
        data({ choices: [{ delta: {}, finish_reason: terminal }] }),
      )
      await record.finish()
      if (terminal === "tool_calls")
        expect((await incident(record)).reasons).toContain(
          "malformed_tool_arguments",
        )
      else expect(await readStreamIncident(record.requestId)).toBeUndefined()
    }
  })

  test("a complete split tool argument is not rejected or re-parsed as separate JSON values", async () => {
    const record = recorder()
    for (const arguments_ of ['{"path":', '"src/index.ts"}'])
      record.observe(
        "downstream",
        data({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 3, function: { arguments: arguments_ } }],
              },
            },
          ],
        }),
      )
    record.observe("downstream", done)
    await record.finish()
    expect(await readStreamIncident(record.requestId)).toBeUndefined()
  })

  test("redacts credentials and media, including credentials split between deltas", async () => {
    const record = recorder()
    const token = "credential-unique-private-value"
    record.request("dispatch-input", {
      authorization: token,
      contents: "safe prompt",
      image: "private image bytes",
    })
    record.attempt({ protocol: "test" }, {}, token)
    record.observe("downstream", delta(token.slice(0, 13)))
    record.observe("downstream", delta(token.slice(13)))
    record.observe(
      "downstream",
      data({ type: "error", error: { message: `Bearer ${token}` } }),
    )
    await record.finish()
    const result = await incident(record)
    const raw = JSON.stringify(result)
    expect(raw).not.toContain(token)
    expect(raw).not.toContain("private image bytes")
    expect(result.streams[0].framesOmittedForSecrets).toBe(true)
    expect(result.streams[0].frames).toEqual([])
    expect(raw).toContain("safe prompt")
  })

  test("enabled upstream redaction permits metadata only, never a backdoor to original or restored content", async () => {
    const settings = systemConfig.getSystemSettings()
    const mockSettings = spyOn(
      systemConfig,
      "getSystemSettings",
    ).mockReturnValue({
      ...settings,
      redaction: { ...settings.redaction, enabled: true },
    })
    try {
      const record = recorder()
      record.request("dispatch-input", { text: "private prompt" })
      record.observe("downstream", delta("restored private response"))
      record.observe("downstream", data({ type: "error" }))
      await record.finish()
      const result = await incident(record)
      expect(JSON.stringify(result)).not.toContain("private prompt")
      expect(JSON.stringify(result)).not.toContain("restored private response")
      expect(result.streams[0].frames).toEqual([])
      expect(result.streams[0].textBytes).toBe(25)
    } finally {
      mockSettings.mockRestore()
    }
  })

  test("recording and request bodies stay bounded while counters describe the entire stream", async () => {
    const record = recorder()
    record.request("dispatch-input", { text: "界".repeat(80_000) })
    for (let attempt = 0; attempt < 9; attempt++) {
      const id = record.attempt(
        { protocol: "test" },
        { text: "q".repeat(30_000) },
      )
      for (let index = 0; index < 150; index++)
        record.observe(
          "upstream-adapter",
          delta(`${index}:` + "unique fragment ".repeat(80)),
          id,
        )
      record.observe("upstream-adapter", done, id)
    }
    record.observe("downstream", data({ type: "error" }))
    await record.finish()
    const result = await incident(record)
    expect(result.requestsTruncated).toBe(true)
    expect(
      result.streams.filter((entry) => entry.stage === "upstream-adapter"),
    ).toHaveLength(8)
    expect(result.streams[0].events).toBe(151)
    expect(result.streams[0].droppedFrames).toBeGreaterThan(0)
    expect(
      result.streams.reduce(
        (sum, entry) =>
          sum
          + entry.frames.reduce(
            (bytes, frame) => bytes + Buffer.byteLength(frame.wireData.text),
            0,
          ),
        0,
      ),
    ).toBeLessThanOrEqual(192 * 1024)
    expect(
      result.requests.reduce(
        (sum, request) => sum + Buffer.byteLength(request.body.text),
        0,
      ),
    ).toBeLessThanOrEqual(96 * 1024)
  })

  test("admission cap and kill switch bound recording, not the application stream", async () => {
    const first = Array.from({ length: 16 }, () => recorder())
    const overflow = recorder()
    overflow.observe("downstream", data({ type: "error" }))
    await overflow.finish()
    expect(await readStreamIncident(overflow.requestId)).toBeUndefined()
    await first[0].finish()
    const admitted = recorder()
    admitted.observe("downstream", data({ type: "error" }))
    await admitted.finish()
    expect(await readStreamIncident(admitted.requestId)).toBeDefined()
    process.env.STREAM_DIAGNOSTICS = "0"
    const disabled = recorder()
    disabled.observe("downstream", data({ type: "error" }))
    await disabled.finish()
    expect(await readStreamIncident(disabled.requestId)).toBeUndefined()
  })

  test("detects downstream expansion without conflating separate upstream attempts", async () => {
    for (const attempts of [1, 2]) {
      const record = recorder()
      for (let attempt = 0; attempt < attempts; attempt++) {
        const id = record.attempt({}, {})
        record.observe("upstream-adapter", delta("a".repeat(512)), id)
        record.observe("upstream-adapter", done, id)
      }
      record.observe("downstream", delta("b".repeat(1024)))
      record.observe("downstream", done)
      await record.finish()
      if (attempts === 1)
        expect((await incident(record)).reasons).toEqual(["output_expansion"])
      else expect(await readStreamIncident(record.requestId)).toBeUndefined()
    }
  })
})

describe("stream recording boundaries", () => {
  async function context(): Promise<Context> {
    let result!: Context
    const app = new Hono()
    app.post("/v1/responses", (c) => {
      initRequestLog(c)
      result = c
      return c.text("ok")
    })
    await app.request("/v1/responses", { method: "POST" })
    return result
  }

  test("observes actual raw HTTP wire, native adapter output and successful SSE batches without changing frames", async () => {
    const c = await context()
    const record = beginStreamDiagnostics(c, { stream: true })!
    recorders.push(record)
    const frames = [
      delta("one"),
      data({ type: "error", error: { message: "fault" } }),
      done,
    ]
    const result = await withStreamDiagnosticAttempt(
      {
        ctx: { c },
        connection: { id: "conn", protocol: "openai-compatible" },
        payload: { stream: true },
      },
      async () => {
        serializeUpstreamBody({ stream: true, model: "upstream-model" })
        const source = frames.map((frame) => `data: ${frame.data}\n\n`).join("")
        return {
          response: await safeSseStream(
            new Response(source, {
              headers: { "content-type": "text/event-stream" },
            }),
            () => null,
          ),
        }
      },
    )
    const events = []
    for await (const event of result.response as AsyncIterable<{
      data: string
    }>)
      events.push(event)
    expect(events.map((event) => event.data)).toEqual(
      frames.map((event) => event.data),
    )
    const sent: string[] = []
    const stream = {
      writeSSE: async ({ data }: { data: string }) => {
        sent.push(data)
      },
      write: async (frame: string | Uint8Array) => {
        sent.push(String(frame))
      },
    }
    attachPerformanceStream(stream, c)
    await writeSseEvents(stream, events)
    await record.finish()
    const saved = await incident(record)
    expect(saved.streams.map((entry) => entry.stage)).toEqual([
      "upstream-wire",
      "upstream-adapter",
      "downstream",
    ])
    expect(saved.streams.map((entry) => entry.events)).toEqual([3, 3, 3])
    expect(
      saved.requests.some((request) =>
        request.body.text.includes("upstream-model"),
      ),
    ).toBe(true)
    expect(sent).toHaveLength(1)
  })

  test("failed client writes never appear as sent and iterator cancellation still releases upstream", async () => {
    const c = await context()
    const record = beginStreamDiagnostics(c, {})!
    recorders.push(record)
    let released = false
    const result = await withStreamDiagnosticAttempt(
      { ctx: { c }, connection: { id: "conn", protocol: "test" }, payload: {} },
      async () => ({
        response: (async function* () {
          try {
            yield delta("hello")
            yield delta("not sent")
          } finally {
            released = true
          }
        })(),
      }),
    )
    const stream = {
      writeSSE: async () => {
        throw new Error("client closed")
      },
    }
    attachPerformanceStream(stream, c)
    await expect(writeSseEvent(stream, delta("not sent").data)).rejects.toThrow(
      "client closed",
    )
    for await (const _event of result.response as AsyncIterable<unknown>) break
    expect(released).toBe(true)
    record.observe("downstream", data({ type: "error" }))
    await record.finish()
    expect(
      (await incident(record)).streams.find(
        (entry) => entry.stage === "downstream",
      )?.events,
    ).toBe(1)
  })

  test("WebSocket recording includes flushed control frames but not rejected sends", async () => {
    const c = await context()
    const record = beginStreamDiagnostics(c, {})!
    recorders.push(record)
    const events = [
      data({ type: "response.created" }),
      data({ type: "response.output_text.delta", delta: "hello" }),
      data({ type: "response.failed" }),
    ]
    const sent: string[] = []
    await pumpWithLeadingBuffer(
      {
        readyState: 1,
        send: (value) => {
          sent.push(String(value))
        },
      },
      (async function* () {
        yield* events
      })(),
      {
        onCommit: () => {},
        onSent: (value) => observeDownstreamEvent(c, value),
      },
    )
    expect(sent).toEqual(events.map((event) => event.data))
    await record.finish("failed")
    expect((await incident(record)).streams[0].events).toBe(3)
    const second = await context()
    const aborted = beginStreamDiagnostics(second, {})!
    recorders.push(aborted)
    await expect(
      pumpWithLeadingBuffer(
        { readyState: 1, send: () => 0 },
        (async function* () {
          yield* events
        })(),
        {
          onCommit: () => {},
          onSent: (value) => observeDownstreamEvent(second, value),
        },
      ),
    ).rejects.toThrow()
    await aborted.finish("cancelled")
    expect(await readStreamIncident(aborted.requestId)).toBeUndefined()
  })

  test("real upstream WebSocket frames remain correlated with the adapter and client send boundary", async () => {
    const c = await context()
    const record = beginStreamDiagnostics(c, { stream: true })!
    recorders.push(record)
    const frames = [
      data({
        type: "response.created",
        response: { id: "resp_ws", model: "grok-test" },
      }),
      ...Array.from({ length: 20 }, () =>
        data({
          type: "response.output_text.delta",
          output_index: 0,
          delta: phrase,
        }),
      ),
      data({
        type: "response.completed",
        response: {
          id: "resp_ws",
          model: "grok-test",
          status: "completed",
          output: [],
        },
      }),
    ]
    using upstream = Bun.serve({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : (
            new Response("upgrade required", { status: 400 })
          )
      },
      websocket: {
        message(socket) {
          for (const frame of frames) socket.send(frame.data)
        },
      },
    })
    try {
      const result = await withStreamDiagnosticAttempt(
        {
          ctx: { c },
          connection: { id: "ws-diagnostic", protocol: "xai-native" },
          payload: { stream: true },
        },
        async () => ({
          response: await openUpstreamResponsesWebsocketTurn({
            provider: "xai",
            accountId: "ws-diagnostic",
            executionSessionId: record.requestId,
            httpResponsesUrl: `http://127.0.0.1:${upstream.port}/responses`,
            headers: {},
            body: { model: "grok-test", stream: true, input: [] },
          }),
        }),
      )
      const sent: string[] = []
      await pumpWithLeadingBuffer(
        {
          readyState: 1,
          send(value) {
            sent.push(String(value))
          },
        },
        result.response as AsyncIterable<{ data: string }>,
        {
          onCommit: () => {},
          onSent: (value) => observeDownstreamEvent(c, value),
        },
      )
      expect(sent).toEqual(frames.map((frame) => frame.data))
      await record.finish()
      const saved = await incident(record)
      expect(saved.streams.map((entry) => entry.stage)).toEqual([
        "upstream-wire",
        "upstream-adapter",
        "downstream",
      ])
      // The WS transport appends its own [DONE] sentinel; it is not a wire
      // frame, and the client pump consumes rather than forwards it.
      expect(saved.streams.map((entry) => entry.events)).toEqual([22, 23, 22])
      expect(saved.streams.map((entry) => entry.textBytes)).toEqual(
        Array(3).fill(Buffer.byteLength(phrase.repeat(20))),
      )
      expect(saved.reasons).toContain("repetition:upstream-wire")
    } finally {
      clearUpstreamWebsocketSessionsForTest()
    }
  })

  test("admin subroutes expose incident evidence without cacheable responses", async () => {
    const record = recorder()
    record.observe("downstream", data({ type: "error" }))
    await record.finish()
    const list = await logApiRoutes.request("/stream-incidents")
    expect(list.headers.get("cache-control")).toBe("no-store")
    expect(await list.json()).toMatchObject({
      incidents: [{ requestId: record.requestId }],
    })
    const detail = await logApiRoutes.request(
      `/${record.requestId}/stream-incident`,
    )
    expect(detail.status).toBe(200)
    expect(detail.headers.get("cache-control")).toBe("no-store")
    expect(await detail.json()).toMatchObject({
      requestId: record.requestId,
      reasons: ["error_event"],
    })
    expect(
      (await logApiRoutes.request("/missing/stream-incident")).status,
    ).toBe(404)
    expect(
      (await logApiRoutes.request("/invalid.id/stream-incident")).status,
    ).toBe(400)
  })
})
