import type { Context } from "hono"

import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { requestLogger } from "~/lib/log-middleware"
import { logStore, matchesLogEntry } from "~/lib/log-store"
import {
  beginStreamLog,
  bindRequestLogContext,
  createDetachedRequestLog,
  finalizeRequestLogContext,
  finalizeUpstreamModelAudit,
  finishRequestLog,
  observeUpstreamResponseModel,
  observeUpstreamResponseModelFromSseData,
  patchRequestLog,
} from "~/lib/request-log"

function makeApp(handler: (c: Context) => Response | Promise<Response>) {
  const app = new Hono()
  app.use("*", requestLogger)
  app.post("/v1/chat/completions", handler)
  return app
}

async function call(app: Hono) {
  return app.request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", messages: [] }),
  })
}

describe("upstream model audit in the request log", () => {
  afterEach(() => {
    logStore.clearForTest()
  })

  test("records the reported model and flags a genuine mismatch", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.6-sol", modelUpstream: "gpt-5.6-sol" })
      observeUpstreamResponseModel(c, { model: "gpt-5.4" })
      return c.json({ ok: true })
    })

    await call(app)
    const entry = logStore.query({ limit: 1 }).entries[0]

    expect(entry?.modelResponse).toBe("gpt-5.4")
    expect(entry?.modelMismatch).toBe(true)
    expect(entry?.modelVariant).toBe(false)
    // A successful request whose upstream swapped models is surfaced as a warn.
    expect(entry?.level).toBe("warn")
  })

  test("classifies a date-snapshot difference as a variant, not a mismatch", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, {
        model: "claude-sonnet-4",
        modelUpstream: "claude-sonnet-4",
      })
      observeUpstreamResponseModel(c, {
        type: "message_start",
        message: { model: "claude-sonnet-4-20250514" },
      })
      return c.json({ ok: true })
    })

    await call(app)
    const entry = logStore.query({ limit: 1 }).entries[0]

    expect(entry?.modelResponse).toBe("claude-sonnet-4-20250514")
    expect(entry?.modelMismatch).toBe(false)
    expect(entry?.modelVariant).toBe(true)
    expect(entry?.level).toBe("info")
  })

  test("stays silent when the upstream declares nothing (three-state)", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", modelUpstream: "gpt-5.5" })
      return c.json({ ok: true })
    })

    await call(app)
    const entry = logStore.query({ limit: 1 }).entries[0]

    expect(entry?.modelResponse).toBeUndefined()
    expect(entry?.modelMismatch).toBeUndefined()
    expect(entry?.level).toBe("info")
  })

  test("does not double-count when finalize runs twice", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", modelUpstream: "gpt-5.5" })
      observeUpstreamResponseModel(c, { model: "gpt-5.4" })
      expect(finalizeUpstreamModelAudit(c)).toBe("mismatch")
      // Second call is a no-op and must report the already-settled verdict.
      expect(finalizeUpstreamModelAudit(c)).toBe("mismatch")
      return c.json({ ok: true })
    })

    await call(app)
    expect(logStore.query({ limit: 1 }).entries[0]?.modelResponse).toBe(
      "gpt-5.4",
    )
  })

  test("falls back to the requested model when no mapping was applied", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5" })
      observeUpstreamResponseModel(c, { model: "gpt-5.4" })
      return c.json({ ok: true })
    })

    await call(app)
    expect(logStore.query({ limit: 1 }).entries[0]?.modelMismatch).toBe(true)
  })

  test("surfaces an upstream that contradicts itself within one response", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", modelUpstream: "gpt-5.5" })
      observeUpstreamResponseModel(c, {
        type: "response.created",
        response: { model: "gpt-5.5" },
      })
      observeUpstreamResponseModel(c, {
        type: "response.completed",
        response: { model: "gpt-5.4" },
      })
      return c.json({ ok: true })
    })

    await call(app)
    const entry = logStore.query({ limit: 1 }).entries[0]
    expect(entry?.modelResponse).toBe("gpt-5.4")
    expect(entry?.modelMismatch).toBe(true)
    expect(entry?.modelConflict).toBe(true)
  })

  test("observes streamed events and settles after the stream finishes", async () => {
    const app = makeApp(async (c) => {
      patchRequestLog(c, { model: "gpt-5.5", modelUpstream: "gpt-5.5" })
      beginStreamLog(c)
      observeUpstreamResponseModelFromSseData(
        c,
        JSON.stringify({
          type: "response.created",
          response: { model: "gpt-5.5" },
        }),
        "response.created",
      )
      observeUpstreamResponseModelFromSseData(
        c,
        JSON.stringify({
          type: "response.completed",
          response: { model: "gpt-5.4" },
        }),
        "response.completed",
      )
      observeUpstreamResponseModelFromSseData(c, "[DONE]")
      observeUpstreamResponseModelFromSseData(c, "not-json")
      finishRequestLog(c)
      return c.json({ ok: true })
    })

    await call(app)
    const entry = logStore.query({ limit: 1 }).entries[0]

    expect(entry?.modelResponse).toBe("gpt-5.4")
    expect(entry?.modelMismatch).toBe(true)
  })

  test("filters by modelMismatch", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", modelUpstream: "gpt-5.5" })
      observeUpstreamResponseModel(c, { model: "gpt-5.4" })
      return c.json({ ok: true })
    })
    await call(app)

    const mismatched = logStore.query({ limit: 10, modelMismatch: true })
    expect(mismatched.entries).toHaveLength(1)

    const matched = logStore.query({ limit: 10, modelMismatch: false })
    expect(matched.entries).toHaveLength(0)

    expect(
      matchesLogEntry(mismatched.entries[0], { modelMismatch: true }),
    ).toBe(true)
  })

  /**
   * A row where the upstream declared nothing has `modelMismatch === undefined`
   * (three-state). It must be excluded from BOTH sides of the filter — a
   * `Boolean()` coercion would have swept it into "matched only".
   */
  test("excludes unobserved rows from both sides of the mismatch filter", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "gpt-5.5", modelUpstream: "gpt-5.5" })
      // No observation: the upstream never declared a model.
      return c.json({ ok: true })
    })
    await call(app)

    expect(
      logStore.query({ limit: 10, modelMismatch: true }).entries,
    ).toHaveLength(0)
    expect(
      logStore.query({ limit: 10, modelMismatch: false }).entries,
    ).toHaveLength(0)
    // Unfiltered still sees it.
    expect(logStore.query({ limit: 10 }).entries).toHaveLength(1)
  })

  test("keeps the model search working across all three model fields", async () => {
    const app = makeApp((c) => {
      patchRequestLog(c, { model: "requested", modelUpstream: "mapped" })
      observeUpstreamResponseModel(c, { model: "reported" })
      return c.json({ ok: true })
    })
    await call(app)

    expect(
      logStore.query({ limit: 10, search: "reported" }).entries,
    ).toHaveLength(1)
  })

  /**
   * The Responses WebSocket path does not go through `log-middleware`: it
   * builds a detached turn context, binds it, observes the terminal response,
   * and finalizes the turn itself. That is exactly the path that silently had
   * no audit before, so lock the contract down end to end.
   */
  test("audits a detached WS turn context finalized outside the middleware", async () => {
    const app = makeApp((c) => {
      const turnCtx = createDetachedRequestLog({
        method: "WS",
        path: "/v1/responses",
        endpoint: "responses",
        apiKind: "responses",
        model: "step-5-preview",
        modelRequested: "step-5-preview",
        modelUpstream: "step-5-preview",
        streaming: true,
        outcome: "incomplete",
      })
      bindRequestLogContext(c, turnCtx)

      // The WS pump only ever hands back the terminal response object.
      observeUpstreamResponseModel(c, {
        type: "response.completed",
        response: { model: "step-5-preview-20260101" },
      })
      expect(finalizeUpstreamModelAudit(c)).toBe("variant")

      const finalized = finalizeRequestLogContext(turnCtx, 200, {
        method: "WS",
        path: "/v1/responses",
      })
      expect(finalized.modelResponse).toBe("step-5-preview-20260101")
      expect(finalized.modelVariant).toBe(true)
      expect(finalized.modelMismatch).toBe(false)
      return c.json({ ok: true })
    })

    await call(app)
  })
})
