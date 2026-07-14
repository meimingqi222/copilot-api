import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { saveAdminPasswordToDb, verifyAdminPassword } from "~/lib/request-auth"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

import {
  adminRequest,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"

const originalAdminPassword = state.adminPassword
const originalApiKey = state.legacyApiKey

describe("admin password setup flow", () => {
  beforeEach(() => {
    statsStore.clearUsageStatsForTest()
    state.adminPassword = undefined
    state.legacyApiKey = undefined
    clearAdminAuth()
    clearAdminPasswordConfig()
  })

  afterEach(() => {
    statsStore.clearUsageStatsForTest()
    state.adminPassword = originalAdminPassword
    state.legacyApiKey = originalApiKey
    clearAdminAuth()
    clearAdminPasswordConfig()
  })

  test("GET /admin redirects to /admin/setup when no password configured", async () => {
    const response = await server.fetch(new Request("http://localhost/admin"))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/admin/setup")
  })

  test("GET /admin/setup serves setup page when no password configured", async () => {
    const response = await server.fetch(
      new Request("http://localhost/admin/setup"),
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("Initial Setup")
  })

  test("GET /admin/login redirects to /admin/setup when no password configured", async () => {
    const response = await server.fetch(
      new Request("http://localhost/admin/login"),
    )
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/admin/setup")
  })

  test("POST /admin/setup rejects short passwords", async () => {
    const response = await server.fetch(
      new Request("http://localhost/admin/setup", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "12345" }),
      }),
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain("at least 6 characters")
  })

  test("POST /admin/setup stores password and creates session", async () => {
    const setupResponse = await server.fetch(
      new Request("http://localhost/admin/setup", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "secure-password" }),
      }),
    )
    expect(setupResponse.status).toBe(200)
    const setCookie = setupResponse.headers.get("set-cookie")
    expect(setCookie).toContain("copilot_api_admin=")

    const loginResponse = await server.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "secure-password" }),
      }),
    )
    expect(loginResponse.status).toBe(200)
  })

  test("POST /admin/setup is rejected once password is configured", async () => {
    const setupResponse = await server.fetch(
      new Request("http://localhost/admin/setup", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "secure-password" }),
      }),
    )
    expect(setupResponse.status).toBe(200)

    const secondSetup = await server.fetch(
      new Request("http://localhost/admin/setup", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "another-password" }),
      }),
    )
    expect(secondSetup.status).toBe(400)
  })

  test("GET /admin/setup redirects to login when password already configured", async () => {
    state.adminPassword = "sha256:abc123"

    const response = await server.fetch(
      new Request("http://localhost/admin/setup"),
    )
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/admin/login")
  })

  test("admin API requires session after setup", async () => {
    const setupResponse = await server.fetch(
      new Request("http://localhost/admin/setup", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "secure-password" }),
      }),
    )
    expect(setupResponse.status).toBe(200)

    const noAuth = await server.fetch(
      new Request("http://localhost/admin/api/providers"),
    )
    expect(noAuth.status).toBe(403)

    setupAdminAuth()
    const authed = await server.fetch(
      adminRequest("http://localhost/admin/api/providers"),
    )
    expect(authed.status).toBe(200)
  })

  test("env/CLI password overrides previously stored database password", () => {
    saveAdminPasswordToDb("old-db-password")
    expect(verifyAdminPassword("old-db-password")).toBe(true)

    state.adminPassword = "new-env-password"
    saveAdminPasswordToDb("new-env-password")

    expect(verifyAdminPassword("new-env-password")).toBe(true)
    expect(verifyAdminPassword("old-db-password")).toBe(false)
  })

  test("saveAdminPasswordToDb does not double-hash already hashed passwords", () => {
    const expectedHash = `sha256:${createHash("sha256").update("plain-password").digest("hex")}`

    saveAdminPasswordToDb(expectedHash)
    expect(verifyAdminPassword("plain-password")).toBe(true)

    // Saving the same hash again must keep it unchanged so the original
    // password keeps working.
    saveAdminPasswordToDb(expectedHash)
    expect(verifyAdminPassword("plain-password")).toBe(true)
  })
})
