import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { readJsonBody, readTextBody } from "~/lib/request-body"

describe("readJsonBody", () => {
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
