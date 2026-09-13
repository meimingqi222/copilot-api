import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { buckets } from "~/lib/protected-route-guard/state"
import { resetGuardForTest } from "~/lib/guard"
import {
  DEFAULT_GUARD_CONFIG,
  getGuardConfig,
  resetGuardConfigForTest,
  setGuardConfig,
  validateGuardConfigPatch,
} from "~/lib/guard-config"
import {
  blockPrincipal,
  checkProtectedRouteGuard,
  cleanupProtectedRouteGuardForTest,
  getPrincipalStateForTest,
  idleTtlMs,
  listShadowStats,
  listTempBlocks,
  resetProtectedRouteGuardForTest,
  unblockPrincipal,
} from "~/lib/protected-route-guard"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"
import { server } from "~/server"

import {
  adminRequest,
  clearAdminAuth,
  setupAdminAuth,
} from "./admin-test-utils"

function guardedApp(userId = "user-1") {
  const app = new Hono()
  app.post("/chat/completions", (c) => {
    c.set("userId" as never, userId)
    try {
      checkProtectedRouteGuard(c, {
        routeKind: "reasoning",
        model: "gpt-test",
        messageContent: "same-content",
      })
    } catch (error) {
      return respondToKnownRouteError(c, error) ?? c.text("unexpected", 500)
    }
    return c.json({ ok: true })
  })
  return app
}

describe("guard management", () => {
  beforeEach(() => {
    setupAdminAuth()
  })

  afterEach(() => {
    resetProtectedRouteGuardForTest()
    resetGuardForTest()
    resetGuardConfigForTest()
    clearAdminAuth()
  })

  test("persistent repeated automation content throttles (L2) with metadata", async () => {
    const app = guardedApp()
    const headers = {
      "content-type": "application/json",
      "user-agent": "curl/7.88.1",
    }
    // Same prompt + same model: base 25pts at 8 repeats, scaling to the
    // 50pt soft line at 13 repeats. A couple of retries never block.
    for (let i = 0; i < 12; i++) {
      const res = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers,
      })
      expect(res.status).toBe(200)
    }
    const throttled = await app.request("http://localhost/chat/completions", {
      method: "POST",
      headers,
    })
    expect(throttled.status).toBe(429)
    const blocks = listTempBlocks()
    expect(blocks).toHaveLength(1)
    expect(blocks[0].principal).toBe("user:user-1")
    expect(blocks[0].reason).toContain("repeated_content")
    expect(blocks[0].blockedUntil).toBeGreaterThan(Date.now())
    expect(blocks[0].retryAfterSeconds).toBeGreaterThan(0)
  })

  test("unblockPrincipal clears an active block", async () => {
    blockPrincipal("user:user-9", { reason: "test" })
    expect(listTempBlocks()).toHaveLength(1)
    expect(unblockPrincipal("user:user-9")).toBe(true)
    expect(listTempBlocks()).toHaveLength(0)
  })

  test("unblockPrincipal returns false for unknown principal", () => {
    expect(unblockPrincipal("user:never-seen")).toBe(false)
  })

  test("guard config validation rejects bad patches", () => {
    expect(validateGuardConfigPatch({ foo: 1 }).ok).toBe(false)
    expect(validateGuardConfigPatch({ requestLimit: -1 }).ok).toBe(false)
    expect(validateGuardConfigPatch({ tempBlockMs: 1000 }).ok).toBe(false)
    expect(validateGuardConfigPatch({ failureRateBlockThreshold: 2 }).ok).toBe(
      false,
    )
    expect(validateGuardConfigPatch({ trustedClientPatterns: "x" }).ok).toBe(
      false,
    )
    const good = validateGuardConfigPatch({ requestLimit: 100 })
    expect(good.ok).toBe(true)
  })

  test("guard config ordering holds for single-field patches", () => {
    // The UI submits only changed fields, so ordering must be checked against
    // the effective config, not just when both fields arrive together.
    expect(
      validateGuardConfigPatch({ trustedRequestLimit: 10 }).ok, // < requestLimit 240
    ).toBe(false)
    expect(
      validateGuardConfigPatch({ scoreReviewThreshold: 80 }).ok, // > soft 50
    ).toBe(false)
    expect(
      validateGuardConfigPatch({ scoreSoftThreshold: 95 }).ok, // > severe 75
    ).toBe(false)
    // Consistent single-field edits still pass.
    expect(validateGuardConfigPatch({ scoreReviewThreshold: 20 }).ok).toBe(true)
    expect(validateGuardConfigPatch({ scoreSoftThreshold: 60 }).ok).toBe(true)
    // Unrelated fields are never blocked by existing values.
    expect(validateGuardConfigPatch({ tempBlockMs: 60_000 }).ok).toBe(true)
  })

  test("idle sweep never refunds tokens to a partially drained bucket", () => {
    // A bucket that cannot have refilled to full must survive the sweep;
    // deleting and recreating it at full capacity would refund tokens.
    // 40 tokens at 0.0001/s needs 400,000s to refill — far beyond ttl*2.
    const drained = {
      tokens: 0,
      updatedAt: 1000,
      capacity: 40,
      refillPerSec: 0.0001,
    }
    const drainedKey = "user:slow:reasoning"
    buckets.set(drainedKey, drained)

    cleanupProtectedRouteGuardForTest(1000 + idleTtlMs() * 2 + 40_000)
    expect(buckets.has(drainedKey)).toBe(true)

    // Once a full refill is provably possible, the bucket is reclaimed.
    cleanupProtectedRouteGuardForTest(1000 + 400_010 * 1000)
    expect(buckets.has(drainedKey)).toBe(false)
  })

  test("guard config defaults match legacy constants", () => {
    const cfg = getGuardConfig()
    expect(cfg.requestLimit).toBe(DEFAULT_GUARD_CONFIG.requestLimit)
    expect(cfg.tempBlockMs).toBe(30 * 60 * 1000)
  })

  test("GET /admin/api/guard/config returns config and defaults", async () => {
    const res = await server.fetch(
      adminRequest("http://localhost/admin/api/guard/config"),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      config: Record<string, unknown>
      defaults: Record<string, unknown>
    }
    expect(body.config.requestLimit).toBeDefined()
    expect(body.defaults.tempBlockMs).toBe(30 * 60 * 1000)
  })

  test("PUT /admin/api/guard/config rejects invalid and persists valid", async () => {
    const bad = await server.fetch(
      adminRequest("http://localhost/admin/api/guard/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestLimit: -5 }),
      }),
    )
    expect(bad.status).toBe(400)

    const good = await server.fetch(
      adminRequest("http://localhost/admin/api/guard/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestLimit: 123 }),
      }),
    )
    expect(good.status).toBe(200)
    expect(getGuardConfig().requestLimit).toBe(123)
  })

  test("token bucket throttles bursts with 429 without temp-blocking", async () => {
    setGuardConfig({ bucketCapacity: 10 })
    const app = guardedApp("user-bucket")
    const headers = {
      "content-type": "application/json",
      "user-agent": "claude-code/1.0.0",
    }
    // Trusted clients get 2x capacity (20); distinct behavior score stays 0
    // because trusted UAs are exempt from the repeat signal.
    for (let i = 0; i < 20; i++) {
      const res = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers,
      })
      expect(res.status).toBe(200)
    }
    const limited = await app.request("http://localhost/chat/completions", {
      method: "POST",
      headers,
    })
    expect(limited.status).toBe(429)
    // Pure rate limiting never creates a temp block.
    expect(listTempBlocks()).toHaveLength(0)
  })

  test("shadow mode logs would-block without enforcing", async () => {
    setGuardConfig({ shadowMode: true })
    const app = guardedApp("user-shadow")
    const headers = {
      "content-type": "application/json",
      "user-agent": "curl/7.88.1",
    }
    for (let i = 0; i < 13; i++) {
      const res = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers,
      })
      expect(res.status).toBe(200)
    }
    expect(listTempBlocks()).toHaveLength(0)
    expect(listShadowStats().some((s) => s.hits > 0)).toBe(true)
  })

  test("manual unblock suppresses same-category re-block within the window", async () => {
    blockPrincipal("user:user-1", { reason: "behavior_block:seed" })
    expect(unblockPrincipal("user:user-1")).toBe(true)
    const app = guardedApp()
    const headers = {
      "content-type": "application/json",
      "user-agent": "curl/7.88.1",
    }
    for (let i = 0; i < 13; i++) {
      const res = await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers,
      })
      expect(res.status).toBe(200)
    }
    expect(listTempBlocks()).toHaveLength(0)
  })

  test("repeat offense within the window escalates L2 to L3", async () => {
    const app = guardedApp("user-escalate")
    const headers = {
      "content-type": "application/json",
      "user-agent": "curl/7.88.1",
    }
    for (let i = 0; i < 12; i++) {
      await app.request("http://localhost/chat/completions", {
        method: "POST",
        headers,
      })
    }
    const first = await app.request("http://localhost/chat/completions", {
      method: "POST",
      headers,
    })
    expect(first.status).toBe(429)
    expect(listTempBlocks()[0]?.level).toBe("L2-short")

    // Follow-ups during an L2 block stay 429 (throttle), not 403.
    const during = await app.request("http://localhost/chat/completions", {
      method: "POST",
      headers,
    })
    expect(during.status).toBe(429)

    // Expire the block but stay inside the escalation window.
    const state = getPrincipalStateForTest("user:user-escalate")
    expect(state).toBeDefined()
    if (!state) throw new Error("expected guard state")
    state.blockedUntil = Date.now() - 1000

    const second = await app.request("http://localhost/chat/completions", {
      method: "POST",
      headers,
    })
    expect(second.status).toBe(403)
    expect(listTempBlocks()[0]?.level).toBe("L3-standard")
  })

  test("temp-blocks API round-trips block/list/unblock", async () => {
    const created = await server.fetch(
      adminRequest("http://localhost/admin/api/guard/temp-blocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principal: "user:api-roundtrip",
          durationMs: 60000,
          reason: "test",
        }),
      }),
    )
    expect(created.status).toBe(200)

    const listed = await server.fetch(
      adminRequest("http://localhost/admin/api/guard/temp-blocks"),
    )
    expect(listed.status).toBe(200)
    const listedBody = (await listed.json()) as {
      blocks: Array<{ principal: string }>
    }
    expect(
      listedBody.blocks.some((b) => b.principal === "user:api-roundtrip"),
    ).toBe(true)

    const removed = await server.fetch(
      adminRequest("http://localhost/admin/api/guard/temp-blocks", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principal: "user:api-roundtrip" }),
      }),
    )
    expect(removed.status).toBe(200)
  })

  test("overview and principals endpoints respond", async () => {
    blockPrincipal("user:overview-check", { reason: "test" })
    const overview = await server.fetch(
      adminRequest("http://localhost/admin/api/guard/overview"),
    )
    expect(overview.status).toBe(200)
    const overviewBody = (await overview.json()) as { tempBlocked: number }
    expect(overviewBody.tempBlocked).toBeGreaterThanOrEqual(1)

    const principals = await server.fetch(
      adminRequest("http://localhost/admin/api/guard/principals?limit=50"),
    )
    expect(principals.status).toBe(200)
    const principalsBody = (await principals.json()) as {
      principals: Array<{ principal: string }>
      total: number
    }
    expect(
      principalsBody.principals.some(
        (p) => p.principal === "user:overview-check",
      ),
    ).toBe(true)
  })
})
