import type { Context } from "hono"

import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { requestLogger } from "~/lib/log-middleware"
import { logStore } from "~/lib/log-store"
import { ClientAbortError } from "~/lib/request-lifecycle"
import {
  markStreamTerminal,
  patchRequestLog,
  recordTraceError,
} from "~/lib/request-log"

/**
 * Regression tests for the abort/outcome classification bug.
 *
 * A client that disconnects before dispatch produces a native `AbortError`
 * (DOMException / undici "The connection was closed.") — NOT our
 * `ClientAbortError`. That used to fall through `classifyTraceError`'s
 * `instanceof ClientAbortError` check into the catch-all, recording
 * `origin: "proxy" / kind: "unknown" / outcome: "failed"` for a request that
 * the stream terminal had already marked `client_abort` / `cancelled`.
 */
function makeApp(handler: (c: Context) => Response | Promise<Response>) {
  const app = new Hono()
  app.use("*", requestLogger)
  app.post("/v1/chat/completions", handler)
  return app
}

function call(app: Hono, signal?: AbortSignal) {
  return app.request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", messages: [] }),
    signal,
  })
}

/** Mirrors the DOMException Bun/undici throws on a client disconnect. */
function connectionClosedAbortError(): Error {
  const error = new Error("The connection was closed.")
  error.name = "AbortError"
  return error
}

describe("trace error classification", () => {
  afterEach(() => {
    logStore.clearForTest()
  })

  test("classifies a native AbortError on an aborted client signal as an abort", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", connectionId: "conn-1" })
      markStreamTerminal(c, "client_abort", "cancelled", false)
      expect(c.req.raw.signal.aborted).toBe(true)
      recordTraceError(c, connectionClosedAbortError())
      return c.json({ ok: true })
    })

    // A real client disconnect: the request signal is already aborted by the
    // time the handler observes the upstream error.
    const controller = new AbortController()
    controller.abort()
    await call(app, controller.signal)

    const entry = logStore.query({ limit: 1 }).entries[0]
    expect(entry?.diagnosticError?.origin).toBe("cancelled")
    expect(entry?.diagnosticError?.kind).toBe("abort")
    expect(entry?.errorType).toBe("abort_error")
    expect(entry?.upstreamStatus).toBe(499)
    // The contradiction this bug produced: terminal said cancelled, outcome
    // said failed.
    expect(entry?.protocolTerminal).toBe("client_abort")
    expect(entry?.outcome).toBe("cancelled")
  })

  test("does not mislabel an internal timeout abort as a client disconnect", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", connectionId: "conn-1" })
      // Client signal is NOT aborted: this is our own AbortSignal.timeout().
      recordTraceError(c, connectionClosedAbortError())
      return c.json({ ok: true })
    })

    await call(app)

    const entry = logStore.query({ limit: 1 }).entries[0]
    expect(entry?.diagnosticError?.origin).not.toBe("cancelled")
    expect(entry?.errorType).not.toBe("abort_error")
    expect(entry?.upstreamStatus).not.toBe(499)
  })

  test("still recognizes our explicit ClientAbortError without a signal check", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", connectionId: "conn-1" })
      recordTraceError(c, new ClientAbortError())
      return c.json({ ok: true })
    })

    await call(app)

    const entry = logStore.query({ limit: 1 }).entries[0]
    expect(entry?.diagnosticError?.origin).toBe("cancelled")
    expect(entry?.diagnosticError?.kind).toBe("abort")
    expect(entry?.outcome).toBe("cancelled")
  })

  test("never overwrites an already-settled cancelled terminal", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5" })
      markStreamTerminal(c, "response.completed", "cancelled", true)
      // A later, unrelated error must not flip the settled outcome.
      recordTraceError(c, new Error("some transport noise"))
      return c.json({ ok: true })
    })

    await call(app)
    expect(logStore.query({ limit: 1 }).entries[0]?.outcome).toBe("cancelled")
  })

  test("never overwrites an already-settled failed terminal", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5" })
      markStreamTerminal(c, "response.failed", "failed", false)
      recordTraceError(c, new Error("late noise"))
      return c.json({ ok: true })
    })

    await call(app)
    expect(logStore.query({ limit: 1 }).entries[0]?.outcome).toBe("failed")
  })

  test("keeps recording a real upstream failure as failed", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", connectionId: "conn-1" })
      recordTraceError(c, new Error("upstream exploded"))
      return c.json({ ok: true })
    })

    await call(app)
    const entry = logStore.query({ limit: 1 }).entries[0]
    expect(entry?.outcome).toBe("failed")
    expect(entry?.diagnosticError?.origin).toBe("proxy")
  })
})
