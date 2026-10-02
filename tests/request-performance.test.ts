import { describe, expect, test } from "bun:test"
import { Hono, type Context } from "hono"

import {
  addRequestTranslationTime,
  hasVisibleText,
  markPerformanceDispatch,
  markPerformanceOutput,
  markPerformanceWrite,
  observePerformanceData,
  requestPerformanceSnapshot,
  startRequestPerformance,
  measureTranslatedStream,
} from "~/lib/request-performance"
import {
  attachPerformanceStream,
  writeSseComment,
  writeSseEvent,
} from "~/lib/sse"
import {
  computePerformanceDetails,
  summarizeTimings,
} from "~/lib/stats/performance-detail"
import type { UsageRawRow } from "~/lib/stats/types"
import { statsStore } from "~/lib/stats-store"

async function context(method = "POST"): Promise<Context> {
  let captured: Context | undefined
  const app = new Hono()
  app.all("*", (c) => {
    captured = c
    return c.text("ok")
  })
  await app.request("http://localhost/v1/responses", { method })
  if (!captured) throw new Error("Missing test request context")
  return captured
}

function row(performanceJson?: string | null): UsageRawRow {
  return {
    model: "gpt-test",
    provider: "codex",
    account_id: "account",
    user_id: null,
    prompt_tokens: 10,
    completion_tokens: 300,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 310,
    cost: 0,
    timestamp: Date.now(),
    ttft_ms: 8000,
    tps: 30,
    streaming: 1,
    performance_json: performanceJson,
  }
}

describe("request performance measurement", () => {
  test("separates preprocessing, first output and post-output duration without changing effective TPS", async () => {
    const c = await context()
    startRequestPerformance(c, 0)
    markPerformanceDispatch(c, 1000)
    markPerformanceDispatch(c, 2000)
    markPerformanceOutput(c, 8000)
    markPerformanceOutput(c, 9000)
    markPerformanceWrite(c, 8100)
    const metrics = requestPerformanceSnapshot(c, true, 10000)
    expect(metrics).toMatchObject({
      outputTtftMs: 8000,
      generationMs: 2000,
      preprocessingMs: 1000,
      dispatchToOutputMs: 7000,
      firstWriteMs: 8100,
    })
    const details = computePerformanceDetails([row(JSON.stringify(metrics))])
    expect(details[0]?.generationTps).toBe(150)
    expect(row().tps).toBe(30)
    expect(
      requestPerformanceSnapshot(c, false, 10000)?.generationMs,
    ).toBeUndefined()
  })

  test("reasoning, tools and control frames are not visible answer text", () => {
    for (const frame of [
      { type: "response.reasoning_summary_text.delta", delta: "thinking" },
      { type: "response.function_call_arguments.delta", delta: "{}" },
      { type: "response.created" },
      { type: "content_block_delta", delta: { thinking: "think" } },
      {
        choices: [
          {
            delta: { reasoning_content: "think", tool_calls: [{ id: "tool" }] },
          },
        ],
      },
    ])
      expect(hasVisibleText(frame)).toBe(false)
    for (const frame of [
      { type: "response.output_text.delta", delta: "text" },
      { type: "response.refusal.delta", delta: "refused" },
      { type: "content_block_delta", delta: { text: "text" } },
      { choices: [{ delta: { content: "text" } }] },
      {
        response: {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "text" }],
            },
          ],
        },
      },
    ])
      expect(hasVisibleText(frame)).toBe(true)
  })

  test("SSE heartbeats and failed writes do not count as first frame written", async () => {
    const c = await context()
    startRequestPerformance(c)
    const stream = { write: async () => {}, writeSSE: async () => {} }
    attachPerformanceStream(stream, c)
    await writeSseComment(stream)
    expect(requestPerformanceSnapshot(c, true)?.firstWriteMs).toBeUndefined()
    await writeSseEvent(stream, JSON.stringify({ type: "response.created" }))
    expect(
      requestPerformanceSnapshot(c, true)?.firstWriteMs,
    ).toBeGreaterThanOrEqual(0)
    expect(requestPerformanceSnapshot(c, true)?.textTtftMs).toBeUndefined()
    await writeSseEvent(
      stream,
      JSON.stringify({ type: "response.output_text.delta", delta: "text" }),
    )
    expect(
      requestPerformanceSnapshot(c, true)?.textTtftMs,
    ).toBeGreaterThanOrEqual(0)
    const failed = await context()
    startRequestPerformance(failed)
    const failedStream = {
      writeSSE: async () => {
        throw new Error("closed")
      },
    }
    attachPerformanceStream(failedStream, failed)
    await expect(writeSseEvent(failedStream, "{}")).rejects.toThrow("closed")
    expect(
      requestPerformanceSnapshot(failed, true)?.firstWriteMs,
    ).toBeUndefined()
  })

  test("a new WS turn resets metrics instead of inheriting the previous turn", async () => {
    const c = await context("GET")
    startRequestPerformance(c, 0)
    markPerformanceOutput(c, 100)
    addRequestTranslationTime(c, 3)
    observePerformanceData(
      c,
      '{"type":"response.output_text.delta","delta":"hi"}',
    )
    startRequestPerformance(c, 200)
    expect(requestPerformanceSnapshot(c, true, 300)).toMatchObject({
      transport: "ws",
      translated: false,
    })
    expect(
      requestPerformanceSnapshot(c, true, 300)?.outputTtftMs,
    ).toBeUndefined()
    expect(requestPerformanceSnapshot(c, true, 300)?.textTtftMs).toBeUndefined()
  })

  test("translation instrumentation is lazy and preserves incremental frames", async () => {
    const c = await context()
    startRequestPerformance(c)
    let consumed = 0
    async function* input() {
      consumed += 1
      yield 1
      consumed += 1
      yield 2
    }
    async function* translate(source: AsyncIterable<number>) {
      for await (const item of source) yield item + 1
    }
    const measured = measureTranslatedStream(input(), translate, c)
    expect(consumed).toBe(0)
    expect((await measured.next()).value).toBe(2)
    expect(consumed).toBe(1)
    expect(
      requestPerformanceSnapshot(c, true)?.firstTranslatedFrameMs,
    ).toBeGreaterThanOrEqual(0)
    expect((await measured.next()).value).toBe(3)
    await measured.return(undefined)
  })
})

describe("segmented performance aggregation", () => {
  test("weights post-output TPS by measured duration and ignores missing historical data", () => {
    const metrics = {
      version: 1,
      endpoint: "/v1/responses",
      transport: "http",
      translated: true,
      generationMs: 2000,
      outputTtftMs: 8000,
    }
    const first = row(JSON.stringify(metrics))
    const second = {
      ...row(
        JSON.stringify({ ...metrics, generationMs: 1000, outputTtftMs: 1000 }),
      ),
      completion_tokens: 10,
    }
    const [detail] = computePerformanceDetails([
      first,
      second,
      row(),
      row("null"),
      row("not-json"),
    ])
    expect(detail?.requests).toBe(2)
    expect(detail?.generationSamples).toBe(2)
    expect(detail?.generationTps).toBeCloseTo(310 / 3)
    expect(detail?.timings.outputTtftMs).toMatchObject({
      samples: 2,
      p50: 1000,
      p95: 8000,
    })
    expect(detail?.timings.textTtftMs.average).toBeNull()
    expect(summarizeTimings([NaN, -1, Infinity])).toMatchObject({
      samples: 0,
      p95: null,
    })
  })

  test("keeps API, transport, translation and streaming groups distinct", () => {
    const metrics = {
      version: 1,
      endpoint: "/v1/responses",
      transport: "http",
      translated: false,
    }
    const rows = [
      row(JSON.stringify(metrics)),
      row(JSON.stringify({ ...metrics, transport: "ws" })),
      row(JSON.stringify({ ...metrics, translated: true })),
      row(JSON.stringify({ ...metrics, endpoint: "/v1/messages" })),
      { ...row(JSON.stringify(metrics)), streaming: 0 },
    ]
    expect(computePerformanceDetails(rows)).toHaveLength(5)
  })

  test("persists new metrics alongside historical usage without fabricating timings", () => {
    statsStore.clearUsageStatsForTest()
    const timestamp = Date.now()
    const base = {
      date: statsStore.getDateString(timestamp),
      accountId: "account",
      model: "gpt-test",
      promptTokens: 10,
      completionTokens: 300,
      totalTokens: 310,
      timestamp,
      tps: 30,
      streaming: true,
    }
    statsStore.recordUsage(base)
    statsStore.recordUsage({
      ...base,
      performance: {
        version: 1,
        endpoint: "/v1/responses",
        transport: "ws",
        translated: false,
        generationMs: 2000,
      },
    })
    expect(
      statsStore.getPerformanceDetailsInRange({
        startMs: timestamp,
        endMs: timestamp + 1,
      })[0]?.generationTps,
    ).toBe(150)
    expect(
      statsStore.getPerformanceByModelInRange({
        startMs: timestamp,
        endMs: timestamp + 1,
      })[0]?.avgStreamingTps,
    ).toBe(30)
  })
})
