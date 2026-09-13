import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  cleanupProtectedRouteGuardForTest,
  checkProtectedRouteGuard,
  getProtectedRouteGuardSizeForTest,
  resetProtectedRouteGuardForTest,
  reportUpstream429,
  reportRequestError,
  reportRequestSuccess,
  getPrincipalStateForTest,
  type PrincipalGuardState,
} from "~/lib/protected-route-guard"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"

describe("protected route guard - behavior analysis", () => {
  afterEach(() => {
    resetProtectedRouteGuardForTest()
  })

  test("dense upstream 429 burst alone only logs (no block)", async () => {
    const app = new Hono()
    app.post("/chat/completions", (c) => {
      c.set("userId" as never, "user-1")

      try {
        checkProtectedRouteGuard(c, { routeKind: "reasoning" })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      reportUpstream429(c)
      return c.json({ ok: true })
    })

    for (let i = 0; i < 5; i++) {
      const response = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
      })
      expect(response.status).toBe(200)
    }

    // A lone upstream-429 signal (25pts) stays below the soft line: the next
    // request still passes. Upstream pressure alone must not hard-block.
    const nextResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
    )
    expect(nextResponse.status).toBe(200)
  })

  test("total upstream 429 threshold alone only logs (no block)", async () => {
    const app = new Hono()
    const realNow = Date.now
    let now = Date.now()
    Date.now = () => now

    app.post("/chat/completions", (c) => {
      c.set("userId" as never, "user-1")

      try {
        checkProtectedRouteGuard(c, { routeKind: "reasoning" })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      reportUpstream429(c)
      reportRequestSuccess(c)
      return c.json({ ok: true })
    })

    try {
      for (let i = 0; i < 15; i++) {
        now += 40_000
        const response = await app.request(
          "http://localhost/chat/completions",
          {
            method: "POST",
            headers: {
              "user-agent": "claude-code/1.0.0",
            },
          },
        )
        expect(response.status).toBe(200)
      }

      now += 40_000
      const nextResponse = await app.request(
        "http://localhost/chat/completions",
        {
          method: "POST",
          headers: {
            "user-agent": "claude-code/1.0.0",
          },
        },
      )
      // 15 upstream 429s over 10min (20pts) stay below the soft line alone.
      expect(nextResponse.status).toBe(200)
    } finally {
      Date.now = realNow
    }
  })

  test("blocks on high failure rate (>= 70%)", async () => {
    const app = new Hono()
    app.post("/chat/completions", async (c) => {
      c.set("userId" as never, "user-1")
      const payload = await c.req.json<{ fail?: boolean }>()

      try {
        checkProtectedRouteGuard(c, { routeKind: "reasoning" })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      if (payload.fail) {
        reportRequestError(c)
      } else {
        reportRequestSuccess(c)
      }

      return c.json({ ok: true })
    })

    for (let i = 0; i < 6; i++) {
      await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fail: false }),
      })
    }

    for (let i = 0; i < 14; i++) {
      const response = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fail: true }),
      })
      if (i < 13) {
        expect(response.status).toBe(200)
      }
    }

    const blockedResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fail: true }),
      },
    )
    // High failure alone reaches the soft (L2 throttle) line: 429, retryable.
    expect(blockedResponse.status).toBe(429)
  })

  test("automated clients have lower failure rate threshold (49%)", async () => {
    const app = new Hono()
    app.post("/chat/completions", async (c) => {
      c.set("userId" as never, "user-1")
      const payload = await c.req.json<{ fail?: boolean }>()

      try {
        checkProtectedRouteGuard(c, { routeKind: "reasoning" })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      if (payload.fail) {
        reportRequestError(c)
      } else {
        reportRequestSuccess(c)
      }

      return c.json({ ok: true })
    })

    for (let i = 0; i < 10; i++) {
      await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "python-requests/2.28.0",
        },
        body: JSON.stringify({ fail: false }),
      })
    }

    for (let i = 0; i < 10; i++) {
      await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "python-requests/2.28.0",
        },
        body: JSON.stringify({ fail: true }),
      })
    }

    const blockedResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "python-requests/2.28.0",
        },
        body: JSON.stringify({ fail: true }),
      },
    )
    // 50% failure clears the lowered 49% automation line → L2 throttle.
    expect(blockedResponse.status).toBe(429)
  })

  test("trusted clients are not marked as automated", async () => {
    const app = new Hono()
    app.post("/chat/completions", async (c) => {
      c.set("userId" as never, "user-1")
      const payload = await c.req.json<{ fail?: boolean }>()

      try {
        checkProtectedRouteGuard(c, { routeKind: "reasoning" })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      if (payload.fail) {
        reportRequestError(c)
      } else {
        reportRequestSuccess(c)
      }

      return c.json({ ok: true })
    })

    for (let i = 0; i < 6; i++) {
      await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "claude-code/1.0.0",
        },
        body: JSON.stringify({ fail: false }),
      })
    }

    for (let i = 0; i < 5; i++) {
      const response = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "claude-code/1.0.0",
        },
        body: JSON.stringify({ fail: true }),
      })
      expect(response.status).toBe(200)
    }

    const stillOkResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "claude-code/1.0.0",
        },
        body: JSON.stringify({ fail: true }),
      },
    )
    expect(stillOkResponse.status).toBe(200)
  })

  test("prefers user identity over shared IP address", async () => {
    const app = new Hono()
    app.post("/chat/completions", (c) => {
      const userId = c.req.header("x-user-id") ?? "anonymous"
      c.set("userId" as never, userId)

      try {
        checkProtectedRouteGuard(c, { routeKind: "reasoning" })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      reportUpstream429(c)
      return c.json({ ok: true })
    })

    for (let i = 0; i < 5; i++) {
      const response = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "user-a",
          "x-forwarded-for": "203.0.113.10",
        },
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
      },
    )

    expect(otherUserResponse.status).toBe(200)
  })

  test("block expires after timeout", async () => {
    const app = new Hono()
    app.post("/chat/completions", async (c) => {
      c.set("userId" as never, "user-1")
      const payload = await c.req.json<{ fail?: boolean }>().catch(() => ({}))

      try {
        checkProtectedRouteGuard(c, { routeKind: "reasoning" })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      if ((payload as { fail?: boolean }).fail) {
        reportRequestError(c)
      } else {
        reportRequestSuccess(c)
      }
      return c.json({ ok: true })
    })

    for (let i = 0; i < 6; i++) {
      await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fail: false }),
      })
    }
    for (let i = 0; i < 14; i++) {
      await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fail: true }),
      })
    }

    const blockedResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fail: true }),
      },
    )
    expect(blockedResponse.status).toBe(429)

    const state = getPrincipalStateForTest("user:user-1") as PrincipalGuardState
    expect(state).toBeDefined()
    const now = Date.now()
    state.blockedUntil = now - 1000
    state.events = state.events.filter((e) => e.type !== "error")

    const recoveredResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fail: false }),
      },
    )
    expect(recoveredResponse.status).toBe(200)
  })

  test("combined upstream429 + repeated content reaches the soft line", async () => {
    const app = new Hono()
    app.post("/chat/completions", (c) => {
      c.set("userId" as never, "user-combo")

      try {
        checkProtectedRouteGuard(c, {
          routeKind: "reasoning",
          model: "gpt-test",
          messageContent: "same-content",
        })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      reportUpstream429(c)
      return c.json({ ok: true })
    })

    const headers = {
      "content-type": "application/json",
      "user-agent": "curl/7.88.1",
    }
    // 5 upstream 429s (25pts) + 8 same-content repeats (25pts) = 50 → L2.
    for (let i = 0; i < 7; i++) {
      const response = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers,
      })
      expect(response.status).toBe(200)
    }
    const throttled = await app.request("http://localhost/chat/completions", {
      method: "POST",
      headers,
    })
    expect(throttled.status).toBe(429)
  })

  test("idle principals are cleaned up after their state expires", async () => {
    const app = new Hono()
    app.post("/chat/completions", (c) => {
      c.set("userId" as never, "user-1")

      try {
        checkProtectedRouteGuard(c, {
          routeKind: "reasoning",
          model: "gpt-5-mini",
        })
      } catch (error) {
        return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
      }

      reportRequestSuccess(c)
      return c.json({ ok: true })
    })

    const response = await app.request("http://localhost/chat/completions", {
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(getProtectedRouteGuardSizeForTest()).toBe(1)

    const state = getPrincipalStateForTest("user:user-1") as PrincipalGuardState
    expect(state).toBeDefined()
    expect(state.lastSeen).toBeGreaterThan(0)
    expect(state.events.length).toBe(2)
    expect(state.recentRequests.length).toBe(1)

    state.lastSeen = 1000
    state.events = []
    state.recentRequests = []
    state.blockedUntil = undefined

    cleanupProtectedRouteGuardForTest(1000 + 40 * 60 * 1000 + 1001)
    expect(getProtectedRouteGuardSizeForTest()).toBe(0)
  })
})
