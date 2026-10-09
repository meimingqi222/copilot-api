import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { HTTPError } from "~/lib/error"
import { readBinaryBody, readJsonBody, readTextBody } from "~/lib/request-body"
import { getRequestLogContext, initRequestLog } from "~/lib/request-log"
import { requestPerformanceSnapshot } from "~/lib/request-performance"

describe("readJsonBody", () => {
  test("keeps split UTF-8 text intact across empty and small chunks", async () => {
    const source = new TextEncoder().encode(JSON.stringify({ text: "中文😀" }))
    const request = new Request("http://localhost", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          for (const byte of source) {
            controller.enqueue(new Uint8Array(0))
            controller.enqueue(new Uint8Array([byte]))
          }
          controller.close()
        },
      }),
      duplex: "half",
    })
    expect(
      await readJsonBody<{ text: string }>(request, source.byteLength),
    ).toEqual({
      text: "中文😀",
    })
  })
  test("retains a single body chunk without allocating another large buffer", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    const request = new Request("http://localhost", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk)
          controller.close()
        },
      }),
      duplex: "half",
    })
    const bytes = await readBinaryBody(request)
    expect(bytes.buffer).toBe(chunk.buffer)
    expect(bytes.byteLength).toBe(chunk.byteLength)
  })
  test("records actual UTF-8 bytes and separates delayed upload from JSON decoding", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ text: "中文😀" }))
    const app = new Hono()
    app.post("/v1/messages", async (c) => {
      initRequestLog(c)
      await readJsonBody(c.req.raw, 1024, c)
      return c.json({
        log: getRequestLogContext(c)?.entry,
        metrics: requestPerformanceSnapshot(c, false),
      })
    })
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(payload.subarray(0, 3))
        await new Promise((resolve) => setTimeout(resolve, 40))
        controller.enqueue(payload.subarray(3))
        controller.close()
      },
    })
    const response = await app.request("http://localhost/v1/messages", {
      method: "POST",
      body,
      duplex: "half",
    })
    const result = (await response.json()) as {
      log: {
        requestBodyBytes: number
        bodyReadMs: number
        jsonDecodeMs: number
      }
      metrics: { requestBodyBytes: number }
    }
    expect(result.log.requestBodyBytes).toBe(payload.byteLength)
    expect(result.metrics.requestBodyBytes).toBe(payload.byteLength)
    expect(result.log.bodyReadMs).toBeGreaterThan(20)
    expect(result.log.jsonDecodeMs).toBeGreaterThanOrEqual(0)
  })
  test("records body size even when JSON decoding fails", async () => {
    const app = new Hono()
    app.post("/v1/messages", async (c) => {
      initRequestLog(c)
      try {
        await readJsonBody(c.req.raw, 1024, c)
      } catch {
        /* inspect failed decode */
      }
      return c.json(getRequestLogContext(c)?.entry)
    })
    const response = await app.request("http://localhost/v1/messages", {
      method: "POST",
      body: "{invalid",
    })
    const result = (await response.json()) as {
      requestBodyBytes: number
      jsonDecodeMs: number
    }
    expect(result.requestBodyBytes).toBe(8)
    expect(result.jsonDecodeMs).toBeGreaterThanOrEqual(0)
  })
  test("rejects a body over the declared size limit", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-length": "1025" },
      body: "{}",
    })

    await readJsonBody(request, 1024).then(
      () => {
        throw new Error("expected request body limit error")
      },
      (error: unknown) => {
        expect(
          error instanceof HTTPError ? error.response.status : undefined,
        ).toBe(413)
      },
    )
  })

  test("rejects an oversized chunked body", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'))
        controller.enqueue(
          new TextEncoder().encode('"' + "x".repeat(32) + '"}'),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request("http://localhost", {
      method: "POST",
      body,
      duplex: "half",
    })

    await readJsonBody(request, 16).then(
      () => {
        throw new Error("expected request body limit error")
      },
      (error: unknown) => {
        expect(
          error instanceof HTTPError ? error.response.status : undefined,
        ).toBe(413)
      },
    )
    expect(cancelled).toBe(true)
  })

  test("parses a body within the limit", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    })

    const result = await readJsonBody<{ ok: boolean }>(request)
    expect(result).toEqual({ ok: true })
  })

  test("limits form bodies too", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "password=" + "x".repeat(32),
    })

    await readTextBody(request, 16).then(
      () => {
        throw new Error("expected form body limit error")
      },
      (error: unknown) => {
        expect(
          error instanceof HTTPError ? error.response.status : undefined,
        ).toBe(413)
      },
    )
  })
})
