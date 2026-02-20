import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { server } from "~/server"

const originalApiKey = state.apiKey
const originalAdminPassword = state.adminPassword
const originalAdminSessionToken = state.adminSessionToken
const originalAdminSessionExpiresAt = state.adminSessionExpiresAt

beforeEach(() => {
  state.apiKey = undefined
  state.adminPassword = undefined
  state.adminSessionToken = undefined
  state.adminSessionExpiresAt = undefined
})

afterEach(() => {
  state.apiKey = originalApiKey
  state.adminPassword = originalAdminPassword
  state.adminSessionToken = originalAdminSessionToken
  state.adminSessionExpiresAt = originalAdminSessionExpiresAt
})

describe("request auth", () => {
  test("returns 401 for protected routes without API key", async () => {
    state.apiKey = "secret"

    const response = await server.fetch(
      new Request("http://localhost/v1/models"),
    )

    expect(response.status).toBe(401)
    const data = await response.json()
    expect(data).toEqual({
      error: {
        message: "Unauthorized. Provide Authorization: Bearer <API_KEY>.",
        type: "authentication_error",
      },
    })
  })

  test("returns 400 when admin login body is malformed JSON", async () => {
    state.apiKey = "secret"
    state.adminPassword = "admin-secret"

    const response = await server.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      }),
    )

    expect(response.status).toBe(400)
    const data = await response.json()
    expect(data).toEqual({
      error: "Invalid JSON payload.",
    })
  })

  test("does not accept admin session cookie for API routes", async () => {
    state.apiKey = "secret"
    state.adminPassword = "admin-secret"

    const loginResponse = await server.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "admin-secret" }),
      }),
    )
    expect(loginResponse.status).toBe(200)

    const cookie = loginResponse.headers.get("set-cookie")
    const sessionCookie = cookie?.split(";")[0] ?? ""
    const protectedResponse = await server.fetch(
      new Request("http://localhost/v1/models", {
        headers: { cookie: sessionCookie },
      }),
    )

    expect(protectedResponse.status).toBe(401)
  })

  test("does not expose admin password in session cookie", async () => {
    state.apiKey = "secret"
    state.adminPassword = "admin-secret"

    const loginResponse = await server.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "admin-secret" }),
      }),
    )

    const cookie = loginResponse.headers.get("set-cookie") ?? ""
    expect(cookie.includes("admin-secret")).toBe(false)
  })

  test("rejects expired admin session cookie", async () => {
    state.apiKey = "secret"
    state.adminSessionToken = "session-token"
    state.adminSessionExpiresAt = Date.now() - 1000

    const response = await server.fetch(
      new Request("http://localhost/usage", {
        headers: { cookie: "copilot_api_admin=session-token" },
      }),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/admin/login")
  })
})
