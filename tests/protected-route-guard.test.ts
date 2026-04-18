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

  test("blocks after dense upstream 429 burst (5 in 1 minute)", async () => {
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

    const blockedResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
    )
    expect(blockedResponse.status).toBe(403)
  })

  test("blocks after total upstream 429 threshold (15 in 10 minutes)", async () => {
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
      const blockedResponse = await app.request(
        "http://localhost/chat/completions",
        {
          method: "POST",
          headers: {
            "user-agent": "claude-code/1.0.0",
          },
        },
      )
      expect(blockedResponse.status).toBe(403)
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

    for (let i = 0; i < 3; i++) {
      await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fail: false }),
      })
    }

    for (let i = 0; i < 7; i++) {
      const response = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fail: true }),
      })
      if (i < 6) {
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
    expect(blockedResponse.status).toBe(403)
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

    for (let i = 0; i < 6; i++) {
      await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "python-requests/2.28.0",
        },
        body: JSON.stringify({ fail: false }),
      })
    }

    for (let i = 0; i < 6; i++) {
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
    expect(blockedResponse.status).toBe(403)
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
      })
      expect(response.status).toBe(200)
    }

    const blockedResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
      },
    )
    expect(blockedResponse.status).toBe(403)

    const state = getPrincipalStateForTest("user:user-1") as PrincipalGuardState
    expect(state).toBeDefined()
    const now = Date.now()
    state.blockedUntil = now - 1000
    state.events = state.events.filter((e) => e.type !== "upstream_429")

    const recoveredResponse = await app.request(
      "http://localhost/chat/completions",
      {
        method: "POST",
      },
    )
    expect(recoveredResponse.status).toBe(200)
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
