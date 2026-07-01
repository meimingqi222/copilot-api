import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { resetGuardForTest } from "~/lib/guard"
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginProtectionForTest,
} from "~/lib/login-protection"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { sleep } from "~/lib/utils"
import { server } from "~/server"

const TEST_IP = "203.0.113.50"
const originalAdminPassword = state.adminPassword
const originalLegacyApiKey = state.legacyApiKey

beforeEach(() => {
  resetLoginProtectionForTest()
  resetGuardForTest()
  statsStore.clearUsageStatsForTest()
  state.adminPassword = "test-admin-pass"
  state.legacyApiKey = undefined
})

afterEach(() => {
  resetLoginProtectionForTest()
  resetGuardForTest()
  state.adminPassword = originalAdminPassword
  state.legacyApiKey = originalLegacyApiKey
})

describe("login-protection", () => {
  test("allows first attempt from any IP", () => {
    expect(checkLoginAllowed(TEST_IP).allowed).toBe(true)
    expect(checkLoginAllowed("127.0.0.1").allowed).toBe(true)
  })

  test("localhost is always exempt from protection", async () => {
    for (let i = 0; i < 20; i++) {
      await recordLoginFailure("127.0.0.1")
    }
    expect(checkLoginAllowed("127.0.0.1").allowed).toBe(true)
  })

  test("locks IP after 5 failed attempts for 15 minutes", async () => {
    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(TEST_IP)
    }

    const result = checkLoginAllowed(TEST_IP)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(900)
    expect(result.reason).toContain("failed login attempts")
  })

  test("escalates lock to 1 hour after 10 failures", async () => {
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(TEST_IP)
    }

    const result = checkLoginAllowed(TEST_IP)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(900)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(3600)
  })

  test("escalates lock to 24h and adds to guard blacklist after 15 failures", async () => {
    let result: Awaited<ReturnType<typeof recordLoginFailure>> = {
      allowed: true,
    }
    for (let i = 0; i < 15; i++) {
      result = await recordLoginFailure(TEST_IP)
    }

    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(3600)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(86400)
    expect(result.reason).toContain("24 hours")

    const check = checkLoginAllowed(TEST_IP)
    expect(check.allowed).toBe(false)
    expect(check.retryAfterSeconds).toBeGreaterThan(3600)
  })

  test("recordLoginSuccess clears failure history", async () => {
    for (let i = 0; i < 3; i++) {
      await recordLoginFailure(TEST_IP)
    }
    recordLoginSuccess(TEST_IP)
    expect(checkLoginAllowed(TEST_IP).allowed).toBe(true)
  })

  test("enforces minimum interval after 3+ failures", async () => {
    await recordLoginFailure(TEST_IP)
    await recordLoginFailure(TEST_IP)
    await recordLoginFailure(TEST_IP)

    const result = checkLoginAllowed(TEST_IP)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(1)
    expect(result.reason).toContain("wait")
  })

  test("returns remaining attempts before lockout", async () => {
    const r1 = await recordLoginFailure(TEST_IP)
    expect(r1.allowed).toBe(true)
    expect(r1.reason).toContain("4 attempts remaining")

    const r2 = await recordLoginFailure(TEST_IP)
    expect(r2.allowed).toBe(true)
    expect(r2.reason).toContain("3 attempts remaining")
  })
})

describe("login route brute-force integration", () => {
  const remoteHeaders = {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.77",
  }

  test("returns 429 with Retry-After after 5 failed login attempts", async () => {
    for (let i = 0; i < 3; i++) {
      await server.fetch(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: remoteHeaders,
          body: JSON.stringify({ password: "wrong" }),
        }),
      )
    }

    // Pace subsequent attempts to stay above the 1s min-interval gate
    for (let i = 0; i < 3; i++) {
      await sleep(1100)
      await server.fetch(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: remoteHeaders,
          body: JSON.stringify({ password: "wrong" }),
        }),
      )
    }

    const response = await server.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: remoteHeaders,
        body: JSON.stringify({ password: "wrong" }),
      }),
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBeTruthy()
    const data = (await response.json()) as { error: string }
    expect(data.error).toContain("failed login attempts")
  })

  test("successful login resets failure counter", async () => {
    for (let i = 0; i < 3; i++) {
      await server.fetch(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: remoteHeaders,
          body: JSON.stringify({ password: "wrong" }),
        }),
      )
    }

    // Wait for min-interval (1s) to expire so the correct password can go through
    await sleep(1100)

    const okResponse = await server.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: remoteHeaders,
        body: JSON.stringify({ password: "test-admin-pass" }),
      }),
    )

    expect(okResponse.status).toBe(200)

    const wrongResponse = await server.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: remoteHeaders,
        body: JSON.stringify({ password: "wrong" }),
      }),
    )

    expect(wrongResponse.status).toBe(401)
  })
})
