import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { getBlacklist, getSnapshots, resetGuardForTest } from "~/lib/guard"
import { guardMiddleware } from "~/lib/guard-middleware"
import { requestLogger } from "~/lib/log-middleware"
import { logStore } from "~/lib/log-store"
import {
  beginStreamLog,
  finishRequestLog,
  markStreamTerminal,
  recordUpstreamAttempt,
} from "~/lib/request-log"
import { handleSseStream, writeSseEvent } from "~/lib/sse"

describe("log middleware", () => {
  afterEach(() => {
    resetGuardForTest()
    logStore.clearForTest()
  })

  test("does not treat protected-route 429s as global guard errors", async () => {
    const app = new Hono()

    app.use("*", requestLogger)
    app.post("/v1/messages", (c) =>
      c.json(
        {
          error: {
            message: "Rate limit exceeded for protected routes. Retry later.",
            type: "rate_limit_error",
          },
        },
        429,
      ),
    )

    for (let index = 0; index < 12; index += 1) {
      const response = await app.request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "unit-test-client/1.0",
          "x-forwarded-for": "203.0.113.77",
        },
        body: JSON.stringify({
          model: "o1",
          messages: [{ role: "user", content: "hello" }],
        }),
      })

      expect(response.status).toBe(429)
    }

    const snapshot = getSnapshots("ip")[0]
    expect(snapshot.errors).toBe(0)
    expect(snapshot.suspiciousReasons).not.toContain("high_error_rate")
  })

  test("does not feed MiMo bridge websocket handshakes into global guard tracking", async () => {
    const app = new Hono()

    app.use("*", requestLogger)
    app.use("*", guardMiddleware)
    app.get("/ws/mimo", (c) => c.text("Unauthorized", 401))

    for (let index = 0; index < 30; index += 1) {
      const response = await app.request(
        "http://localhost/ws/mimo?accountId=test-account",
        {
          headers: {
            "user-agent": "python-httpx/0.27",
            "x-forwarded-for": "203.0.113.88",
          },
        },
      )

      expect(response.status).toBe(401)
    }

    expect(getSnapshots("ip")).toHaveLength(0)
    expect(getBlacklist()).toHaveLength(0)
  })

  test("persists the protocol outcome after an HTTP 200 stream finishes", async () => {
    const app = new Hono()
    app.use("*", requestLogger)
    app.post("/v1/responses", (c) => {
      beginStreamLog(c)
      return handleSseStream(
        c,
        async (stream) => {
          await Bun.sleep(5)
          markStreamTerminal(c, "response.failed", "failed", true)
          await writeSseEvent(
            stream,
            JSON.stringify({ type: "response.failed" }),
          )
        },
        {
          skipPing: true,
          onFinally: () => finishRequestLog(c),
        },
      )
    })

    const response = await app.request("http://localhost/v1/responses", {
      method: "POST",
    })
    await response.text()

    const entry = logStore.query({ limit: 1 }).entries[0]
    expect(entry.statusCode).toBe(200)
    expect(entry.outcome).toBe("failed")
    expect(entry.protocolTerminal).toBe("response.failed")
    expect(entry.outputObserved).toBe(true)
  })

  test("keeps concurrent upstream attempts on their own request", async () => {
    const app = new Hono()
    app.use("*", requestLogger)
    app.post("/v1/chat/completions", async (c) => {
      const id = c.req.query("id") ?? "unknown"
      await Bun.sleep(id === "a" ? 8 : 1)
      recordUpstreamAttempt(
        c,
        {
          connectionId: `connection-${id}`,
          connectionName: `Readable connection ${id}`,
          credentialId: `credential-${id}`,
          credentialLabel: `Credential ${id}`,
          endpoint: "chat",
          protocol: "openai-compatible",
          provider: "test-provider",
        },
        { status: 200, latencyMs: 1 },
        1,
      )
      return c.json({ id })
    })

    await Promise.all([
      app.request("http://localhost/v1/chat/completions?id=a", {
        method: "POST",
      }),
      app.request("http://localhost/v1/chat/completions?id=b", {
        method: "POST",
      }),
    ])

    const entries = logStore.query({ limit: 10 }).entries
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.attempts).toHaveLength(1)
      expect(entry.attempts?.[0]?.connectionId).toBe(entry.connectionId)
      expect(entry.attempts?.[0]?.credentialId).toBe(entry.credentialId)
      expect(entry.connectionName).toBe(
        `Readable connection ${entry.connectionId?.at(-1)}`,
      )
      expect(entry.credentialLabel).toBe(
        `Credential ${entry.credentialId?.at(-1)}`,
      )
    }
  })
})
