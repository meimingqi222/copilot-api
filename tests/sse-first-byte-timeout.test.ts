import { afterEach, describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import {
  detectOpenAIStreamError,
  resolveSseFirstByteTimeoutMs,
  safeSseStream,
} from "~/services/protocols/shared"

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

async function collect<T>(stream: AsyncIterable<T>): Promise<Array<T>> {
  const out: Array<T> = []
  for await (const event of stream) out.push(event)
  return out
}

describe("safeSseStream first-byte timeout", () => {
  test("passes through a prompt first event without timing out", async () => {
    const stream = await safeSseStream<{ data?: string }>(
      sseResponse('data: {"hello":1}\n\n'),
      () => null,
      { firstByteTimeoutMs: 1000 },
    )
    const events = await collect(stream)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toContain("hello")
  })

  test("throws a 504 failoverable error when the upstream stalls", async () => {
    const hanging = new ReadableStream({
      start() {
        // Never enqueue nor close: simulates a stalled upstream.
      },
    })
    const start = Date.now()
    let error: unknown
    try {
      await safeSseStream(sseResponse(hanging), () => null, {
        firstByteTimeoutMs: 30,
      })
    } catch (err) {
      error = err
    }
    expect(Date.now() - start).toBeLessThan(5000)
    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).response.status).toBe(504)
  })

  test("still surfaces an error frame before any timeout", async () => {
    let error: unknown
    try {
      await safeSseStream(
        sseResponse('data: {"error":{"message":"boom","code":500}}\n\n'),
        detectOpenAIStreamError,
        { firstByteTimeoutMs: 1000 },
      )
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).response.status).toBe(500)
  })
})

describe("resolveSseFirstByteTimeoutMs", () => {
  const KEY = "UPSTREAM_SSE_FIRST_BYTE_TIMEOUT_MS"
  const saved = process.env[KEY]

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
  })

  test("defaults to 120s and honors overrides", () => {
    delete process.env[KEY]
    expect(resolveSseFirstByteTimeoutMs()).toBe(120_000)
    process.env[KEY] = "15000"
    expect(resolveSseFirstByteTimeoutMs()).toBe(15_000)
    process.env[KEY] = "0"
    expect(resolveSseFirstByteTimeoutMs()).toBe(0)
  })

  test("falls back to the default on invalid values", () => {
    process.env[KEY] = "junk"
    expect(resolveSseFirstByteTimeoutMs()).toBe(120_000)
    process.env[KEY] = "-5"
    expect(resolveSseFirstByteTimeoutMs()).toBe(120_000)
  })
})
