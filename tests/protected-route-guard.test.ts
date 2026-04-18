import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  checkProtectedRouteGuard,
  resetProtectedRouteGuardForTest,
} from "~/lib/protected-route-guard"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"

describe("protected route guard", () => {
  afterEach(() => {
    resetProtectedRouteGuardForTest()
  })

  test("expensive reasoning models cool down sooner than cheap models", async () => {
    const app = new Hono()
    app.post("/chat/completions", async (c) => {
      c.set("userId" as never, "user-1")
      const payload = await c.req.json<{ model: string; max_tokens?: number }>()

      try {
        checkProtectedRouteGuard(c, {
          routeKind: "reasoning",
          model: payload.model,
          maxTokens: payload.max_tokens,
        })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      return c.json({ ok: true })
    })

    for (let index = 0; index < 9; index += 1) {
      const response = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "o1", max_tokens: 4096 }),
      })
      expect(response.status).toBe(200)
    }

    const expensiveCooldown = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "o1", max_tokens: 4096 }),
      },
    )
    expect(expensiveCooldown.status).toBe(429)

    resetProtectedRouteGuardForTest()

    for (let index = 0; index < 10; index += 1) {
      const response = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5-mini", max_tokens: 1024 }),
      })
      expect(response.status).toBe(200)
    }
  })

  test("prefers user identity over shared IP address", async () => {
    const app = new Hono()
    app.post("/chat/completions", async (c) => {
      const userId = c.req.header("x-user-id") ?? "anonymous"
      c.set("userId" as never, userId)
      const payload = await c.req.json<{ model: string }>()

      try {
        checkProtectedRouteGuard(c, {
          routeKind: "reasoning",
          model: payload.model,
        })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      return c.json({ ok: true })
    })

    for (let index = 0; index < 9; index += 1) {
      const response = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "user-a",
          "x-forwarded-for": "203.0.113.10",
        },
        body: JSON.stringify({ model: "o1" }),
      })
      expect(response.status).toBe(200)
    }

    const otherUserResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "user-b",
          "x-forwarded-for": "203.0.113.10",
        },
        body: JSON.stringify({ model: "o1" }),
      },
    )

    expect(otherUserResponse.status).toBe(200)
  })
})
