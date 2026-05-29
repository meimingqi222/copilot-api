import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { getBlacklist, getSnapshots, resetGuardForTest } from "~/lib/guard"
import { guardMiddleware } from "~/lib/guard-middleware"
import { requestLogger } from "~/lib/log-middleware"

describe("log middleware", () => {
  afterEach(() => {
    resetGuardForTest()
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
})
