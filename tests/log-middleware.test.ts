import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import {
  addBlacklistEntry,
  getBlacklist,
  getSnapshots,
  resetGuardForTest,
} from "~/lib/guard"
import { guardMiddleware } from "~/lib/guard-middleware"
import { requestLogger } from "~/lib/log-middleware"
import { logStore } from "~/lib/log-store"
import {
  beginStreamLog,
  finishRequestLog,
  markStreamTerminal,
  patchRequestLog,
  recordUpstreamAttempt,
} from "~/lib/request-log"
import { handleSseStream, writeSseEvent } from "~/lib/sse"
import { clearTraceBusForTest, recentTraces } from "~/lib/trace-bus"
import { statsStore } from "~/lib/stats-store"

describe("log middleware", () => {
  afterEach(() => {
    resetGuardForTest()
    logStore.clearForTest()
    clearTraceBusForTest()
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

  test("does not write system logs for blacklisted IPs", async () => {
    await addBlacklistEntry({ value: "203.0.113.99", type: "ip" })

    const app = new Hono()
    app.use("*", requestLogger)
    app.use("*", guardMiddleware)
    app.post("/v1/messages", (c) => c.json({ ok: true }))

    const response = await app.request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "unit-test-client/1.0",
        "x-forwarded-for": "203.0.113.99",
      },
      body: JSON.stringify({
        model: "o1",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(403)
    expect(logStore.query({ limit: 10 }).entries).toHaveLength(0)
  })

  test("persists the protocol outcome after an HTTP 200 stream finishes", async () => {
    statsStore.clearUsageStatsForTest()
    const app = new Hono()
    app.use("*", requestLogger)
    app.post("/v1/responses", (c) => {
      c.set("accountId", "stream-failed-account")
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
    expect(statsStore.getTodayStats("stream-failed-account")).toEqual({
      requests: 1,
      errors: 1,
    })
  })

  test.each(["/v1/chat/completions", "/v1/messages", "/v1/responses"])(
    "settles a requested stream that returns a JSON error on %s",
    async (endpoint) => {
      const app = new Hono()
      app.use("*", requestLogger)
      app.post(endpoint, (c) => {
        patchRequestLog(c, { streaming: true, model: "test-model" })
        return c.json({ error: { message: "Upstream unavailable" } }, 503)
      })
      const response = await app.request(`http://localhost${endpoint}`, {
        method: "POST",
      })
      await response.text()
      const entry = logStore.query({ limit: 1 }).entries[0]
      expect(entry?.statusCode).toBe(503)
      expect(entry?.outcome).toBe("failed")
      const trace = recentTraces().find(
        (record) => record.requestId === response.headers.get("X-Request-Id"),
      )
      expect(trace?.inFlight).toBe(false)
      expect(trace?.outcome).toBe("failed")
    },
  )

  test("does not settle a real SSE response before its producer finishes", async () => {
    const app = new Hono()
    let releaseProducer: (() => void) | undefined
    const producerGate = new Promise<void>((resolve) => {
      releaseProducer = resolve
    })
    app.use("*", requestLogger)
    app.post("/v1/responses", (c) => {
      beginStreamLog(c)
      return handleSseStream(
        c,
        async (stream) => {
          await producerGate
          markStreamTerminal(c, "response.completed", "success", true)
          await writeSseEvent(stream, "done")
        },
        { skipPing: true, onFinally: () => finishRequestLog(c) },
      )
    })
    const response = await app.request("http://localhost/v1/responses", {
      method: "POST",
    })
    const requestId = response.headers.get("X-Request-Id")
    expect(
      recentTraces().find((record) => record.requestId === requestId)?.inFlight,
    ).toBe(true)
    expect(logStore.query({ limit: 10 }).entries).toHaveLength(0)
    releaseProducer?.()
    await response.text()
    expect(
      recentTraces().find((record) => record.requestId === requestId)?.inFlight,
    ).toBe(false)
    expect(logStore.query({ limit: 10 }).entries).toHaveLength(1)
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

  test("非 API 路径的请求不写请求日志/统计，但安全防护快照照常更新", async () => {
    const app = new Hono()

    app.use("*", requestLogger)
    app.get("/ai/credentials", (c) =>
      c.json({ error: { message: "unauthorized" } }, 401),
    )

    const response = await app.request("http://localhost/ai/credentials", {
      headers: {
        "user-agent": "unit-test-scanner/1.0",
        "x-forwarded-for": "45.138.12.10",
      },
    })

    expect(response.status).toBe(401)
    // 不是本服务的 API 调用：不进请求日志（否则追踪列表里会出现"某端点 401"）
    expect(logStore.count()).toBe(0)
    // 安全防护仍然看到这次扫描（暴力破解信号不能丢）
    expect(getSnapshots("ip")[0]?.key).toBe("45.138.12.10")
  })

  test("API 路径照常记录", async () => {
    const app = new Hono()

    app.use("*", requestLogger)
    app.post("/v1/chat/completions", (c) => c.json({ ok: true }))

    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "unit-test-client/1.0",
        "x-forwarded-for": "203.0.113.9",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    })

    expect(response.status).toBe(200)
    expect(logStore.count()).toBe(1)
  })

  test("only Gemini generation is traced, not model listing", async () => {
    const app = new Hono()

    app.use("*", requestLogger)
    app.get("/v1/models", (c) => c.json({ data: [] }))
    app.post("/v1beta/models/gemini-3-pro:generateContent", (c) => c.json({}))

    await app.request("http://localhost/v1/models", {
      headers: { "x-forwarded-for": "203.0.113.11" },
    })
    await app.request(
      "http://localhost/v1beta/models/gemini-3-pro:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.12",
        },
        body: JSON.stringify({}),
      },
    )

    expect(logStore.count()).toBe(1)
    expect(recentTraces().map((record) => record.path)).toEqual([
      "/v1beta/models/gemini-3-pro:generateContent",
    ])
  })

  test.each([
    ["GET", "/v1/models"],
    ["GET", "/models"],
    ["POST", "/v1/messages/count_tokens"],
    ["POST", "/v1beta/models/gemini-pro:countTokens"],
    ["GET", "/v1beta/models"],
    ["POST", "/v1/embeddings"],
    ["POST", "/v1/images/generations"],
    ["GET", "/v1/chat/completions"],
    ["OPTIONS", "/v1/responses"],
    ["POST", "/v1/responses/not-a-route"],
  ])("does not trace non-generation request %s %s", async (method, path) => {
    const app = new Hono()
    app.use("*", requestLogger)
    app.all(path, (c) => c.json({ ok: true }))
    await app.request(`http://localhost${path}`, {
      method,
      headers: { "x-forwarded-for": "203.0.113.13" },
    })
    expect(logStore.count()).toBe(0)
    expect(recentTraces()).toHaveLength(0)
    expect(getSnapshots("ip")[0]?.key).toBe("203.0.113.13")
  })

  test("non-generation requests do not increment account request statistics", async () => {
    const requestSpy = spyOn(
      statsStore,
      "incrementRequests",
    ).mockImplementation(() => {})
    const errorSpy = spyOn(
      statsStore,
      "incrementRequestAndError",
    ).mockImplementation(() => {})
    try {
      const app = new Hono()
      app.use("*", requestLogger)
      app.all("*", (c) => {
        c.set("accountId", "test-stat-account")
        return c.json(
          { ok: true },
          c.req.path.endsWith("count_tokens") ? 400 : 200,
        )
      })
      for (const [method, path] of [
        ["GET", "/v1/models"],
        ["POST", "/v1/messages/count_tokens"],
      ]) {
        await app.request(`http://localhost${path}`, {
          method,
          headers: { "x-forwarded-for": "203.0.113.14" },
        })
      }
      expect(requestSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      await app.request("http://localhost/v1/messages", { method: "POST" })
      expect(requestSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      requestSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  test("被安全防护拉黑的请求不写系统日志，但实时追踪会结算（不再永远'进行中'）", async () => {
    const app = new Hono()

    app.use("*", requestLogger)
    app.post("/v1/chat/completions", (c) => {
      c.set("guardRejected", true)
      return c.json({ error: { message: "blocked" } }, 403)
    })

    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.7",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    })

    expect(response.status).toBe(403)
    // 仍然不写系统日志（黑名单 IP 的请求不落盘）
    expect(logStore.count()).toBe(0)
    // 但实时追踪里那条已经被结算，不会永远显示"进行中"
    const record = recentTraces().find((r) => r.path === "/v1/chat/completions")
    expect(record).toBeTruthy()
    expect(record?.inFlight).toBe(false)
    expect(record?.outcome).toBe("cancelled")
  })
})
