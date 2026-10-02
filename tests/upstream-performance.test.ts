import { expect, test } from "bun:test"
import { Hono, type Context } from "hono"

import {
  addPerformanceTiming,
  markPerformanceOutput,
  markPerformanceWrite,
  markResponseReady,
  markUpstreamEvent,
  markUpstreamSent,
  measurePerformanceStage,
  measureTranslatedStream,
  requestPerformanceSnapshot,
  startRequestPerformance,
} from "~/lib/request-performance"
import {
  bindPerformanceStream,
  measureLocalWork,
  measureUpstreamFetch,
  observeUpstreamResponse,
  performanceContext,
  readUpstreamJson,
  runWithPerformanceContext,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"
import { attachPerformanceStream, writeSseEvent } from "~/lib/sse"
import { readJsonBody } from "~/lib/request-body"

async function context(): Promise<Context> {
  let captured: Context | undefined
  const app = new Hono().get("/", (c) => {
    captured = c
    return c.text("OK")
  })
  await app.request("/")
  if (!captured) throw new Error("Missing context")
  startRequestPerformance(captured, 0)
  return captured
}

test("upstream observation resets per send and output-to-write ignores early control writes", async () => {
  const c = await context()
  markUpstreamSent(c, 10)
  markUpstreamEvent(c, undefined, 30)
  markUpstreamEvent(c, undefined, 40)
  markPerformanceWrite(c, 31)
  markPerformanceOutput(c, 100)
  markPerformanceWrite(c, 110)
  addPerformanceTiming(c, "rateLimitWaitMs", 5)
  addPerformanceTiming(c, "rateLimitWaitMs", 7)
  markResponseReady(c, 120)
  const first = requestPerformanceSnapshot(c, true, 150)
  expect(first?.upstreamFirstEventMs).toBe(20)
  expect(first?.outputToWriteMs).toBe(10)
  expect(first?.upstreamToOutputMs).toBe(70)
  expect(first?.rateLimitWaitMs).toBe(12)
  expect(first?.responseReadyMs).toBe(120)
  markUpstreamSent(c, 200)
  expect(
    requestPerformanceSnapshot(c, true, 210)?.upstreamFirstEventMs,
  ).toBeUndefined()
  markUpstreamEvent(c, 10, 212)
  expect(
    requestPerformanceSnapshot(c, true, 213)?.upstreamFirstEventMs,
  ).toBeUndefined()
  markUpstreamEvent(c, undefined, 215)
  expect(requestPerformanceSnapshot(c, true, 250)?.upstreamFirstEventMs).toBe(
    15,
  )
})

test("HTTP measurement preserves original Response identity and separates headers from body reads", async () => {
  const c = await context()
  const response = new Response('{"ok":true}', {
    headers: { "x-test": "value" },
  })
  await runWithPerformanceContext(c, async () => {
    const measured = await measureUpstreamFetch(async () => {
      await Bun.sleep(10)
      return response
    })
    expect(measured).toBe(response)
    expect(measured.headers.get("x-test")).toBe("value")
    observeUpstreamResponse(measured)
    expect(await readUpstreamJson(measured)).toEqual({ ok: true })
  })
  const metrics = requestPerformanceSnapshot(c, false)
  expect(metrics?.upstreamHeadersMs).toBeGreaterThan(0)
  expect(metrics?.upstreamFirstEventMs).toBeGreaterThan(0)
  expect(metrics?.upstreamBodyReadMs).toBeGreaterThanOrEqual(0)
  expect(metrics?.generationMs).toBeUndefined()
})

test("parallel requests and lazy stream pulls retain isolated performance contexts", async () => {
  const left = await context()
  const right = await context()
  await Promise.all(
    [left, right].map((c) =>
      runWithPerformanceContext(c, async () => {
        await Bun.sleep(5)
        expect(performanceContext()).toBe(c)
      }),
    ),
  )
  expect(performanceContext()).toBeUndefined()
  let cleaned = false
  async function* source() {
    try {
      expect(performanceContext()).toBe(left)
      yield 1
      yield 2
    } finally {
      expect(performanceContext()).toBe(left)
      cleaned = true
    }
  }
  for await (const value of bindPerformanceStream(source(), left)) {
    expect(value).toBe(1)
    break
  }
  expect(cleaned).toBe(true)
  expect(performanceContext()).toBeUndefined()
})

test("stream advancement subtracts upstream pulls and excludes downstream consumer pauses", async () => {
  const c = await context()
  async function* source() {
    await Bun.sleep(60)
    yield "frame"
  }
  async function* translate(input: AsyncIterable<string>) {
    for await (const value of input) yield value
  }
  const stream = measureTranslatedStream(source(), translate, c)
  expect((await stream.next()).value).toBe("frame")
  await Bun.sleep(60)
  await stream.next()
  expect(
    requestPerformanceSnapshot(c, true)?.streamTranslationActiveMs,
  ).toBeLessThan(40)
})

test("local conversion failures preserve errors and disabled instrumentation is transparent", async () => {
  const c = await context()
  const error = new Error("conversion failed")
  expect(() =>
    runWithPerformanceContext(c, () =>
      measureLocalWork("responseTranslationMs", () => {
        throw error
      }),
    ),
  ).toThrow(error)
  expect(
    requestPerformanceSnapshot(c, false)?.responseTranslationMs,
  ).toBeGreaterThanOrEqual(0)
  const response = new Response("OK")
  expect(await measureUpstreamFetch(async () => response)).toBe(response)
  expect(performanceContext()).toBeUndefined()
})

test("request body timing separates delayed upload from JSON decoding", async () => {
  const c = await context()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await Bun.sleep(50)
      controller.enqueue(new TextEncoder().encode('{"ok":true}'))
      controller.close()
    },
  })
  const request = new Request("http://localhost/", { method: "POST", body })
  expect(await readJsonBody<{ ok: boolean }>(request, 1024, c)).toEqual({
    ok: true,
  })
  const metrics = requestPerformanceSnapshot(c, false)
  expect(metrics?.bodyReadMs).toBeGreaterThan(30)
  expect(metrics?.jsonDecodeMs).toBeLessThan(30)
})

test("preprocessing stages preserve results and record failed-stage durations", async () => {
  const c = await context()
  expect(await measurePerformanceStage(c, "tokenEstimateMs", () => 42)).toBe(42)
  const error = new Error("admission failed")
  await expect(
    measurePerformanceStage(c, "admissionMs", async () => {
      await Bun.sleep(5)
      throw error
    }),
  ).rejects.toBe(error)
  const snapshot = requestPerformanceSnapshot(c, false)
  expect(snapshot?.tokenEstimateMs).toBeGreaterThanOrEqual(0)
  expect(snapshot?.admissionMs).toBeGreaterThan(0)
  expect(
    await measurePerformanceStage(undefined, "bodyParseMs", () => "unchanged"),
  ).toBe("unchanged")
})

test("request serialization preserves the wire body and records local preparation", async () => {
  const c = await context()
  const payload = { model: "test", stream: false, messages: [] }
  expect(
    runWithPerformanceContext(c, () => serializeUpstreamBody(payload)),
  ).toBe(JSON.stringify(payload))
  expect(
    requestPerformanceSnapshot(c, false)?.adapterPreparationMs,
  ).toBeGreaterThanOrEqual(0)
  expect(serializeUpstreamBody(payload)).toBe(JSON.stringify(payload))
})

test("structured SSE data bypasses redundant JSON parsing and still captures text and write timing", async () => {
  const c = await context()
  const stream = {
    writeSSE: async () => {
      await Bun.sleep(5)
    },
  }
  attachPerformanceStream(stream, c)
  await writeSseEvent(stream, "invalid-json", undefined, {
    choices: [{ delta: { content: "hello" } }],
  })
  const metrics = requestPerformanceSnapshot(c, true)
  expect(metrics?.textTtftMs).toBeDefined()
  expect(metrics?.firstWriteMs).toBeDefined()
  expect(metrics?.downstreamWriteMs).toBeGreaterThan(0)
})
