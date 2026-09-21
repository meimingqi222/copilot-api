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
import { CredentialConcurrencyLimitError } from "~/services/dispatch/concurrency"

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

  test("classifies a local concurrency rejection as a dispatch condition", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", connectionId: "conn-1" })
      // A per-credential in-flight cap rejection is an HTTPError(429), but it
      // is NOT an upstream failure. Classifying it by status would label the
      // trace `origin: upstream / kind: rate_limited` — the exact reading this
      // fix exists to prevent.
      recordTraceError(
        c,
        new CredentialConcurrencyLimitError("conn-1::cred-1::responses"),
      )
      return c.json({ ok: true })
    })

    await call(app)
    const entry = logStore.query({ limit: 1 }).entries[0]
    expect(entry?.diagnosticError?.origin).toBe("proxy")
    expect(entry?.diagnosticError?.kind).toBe("concurrency_limit")
    expect(entry?.errorType).toBe("concurrency_limit")
    expect(entry?.diagnosticError?.origin).not.toBe("upstream")
    // The retry hint is 1s (`Retry-After: 1` / `retry-after-ms: 1000`);
    // `retry-after-ms` is milliseconds and must not be read as delta-seconds.
    expect(entry?.retryAfterMs).toBe(1000)
    expect(entry?.diagnosticError?.retryAfterMs).toBe(1000)
  })

  test("does not leak the credential key to clients in the error body", async () => {
    const error = new CredentialConcurrencyLimitError(
      "conn-1::cred-1::responses",
    )
    // The routing key is a field for logs, not part of the client message.
    expect(error.credentialKey).toBe("conn-1::cred-1::responses")
    expect(error.responseBody).not.toContain("conn-1::cred-1")
    expect(error.message).not.toContain("conn-1::cred-1")
  })
})
