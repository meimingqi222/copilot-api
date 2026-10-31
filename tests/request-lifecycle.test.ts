import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  ClientAbortError,
  respondToKnownRouteError,
  RouteRateLimitError,
} from "~/lib/request-lifecycle"

describe("request lifecycle helpers", () => {
  test("maps rate limit errors to protocol-specific error payloads", async () => {
    const app = new Hono()
    app.get(
      "/",
      (c) =>
        respondToKnownRouteError(
          c,
          new RouteRateLimitError("busy"),
          "rate_limit_error",
        ) ?? c.text("unreachable"),
    )

    const response = await app.request("http://localhost/")

    expect(response.status).toBe(429)
    const body = await response.json()
    expect(body).toEqual({
      error: { message: "busy", type: "rate_limit_error" },
    })
  })

  test("maps client aborts to 499 responses", async () => {
    const app = new Hono()
    app.get(
      "/",
      (c) =>
        respondToKnownRouteError(c, new ClientAbortError())
        ?? c.text("unreachable"),
    )

    const response = await app.request("http://localhost/")
    expect(response.status).toBe(499)
  })

  test("uses the Anthropic envelope on the messages endpoint", async () => {
    const app = new Hono()
    app.get(
      "/",
      (c) =>
        respondToKnownRouteError(
          c,
          new RouteRateLimitError("busy"),
          "rate_limit_error",
          "anthropic",
        ) ?? c.text("unreachable"),
    )

    const response = await app.request("http://localhost/")
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "busy" },
    })
  })

  test("uses the Gemini envelope on the generateContent endpoint", async () => {
    const app = new Hono()
    app.get(
      "/",
      (c) =>
        respondToKnownRouteError(
          c,
          new RouteRateLimitError("busy"),
          "rate_limit_error",
          "gemini",
        ) ?? c.text("unreachable"),
    )

    const response = await app.request("http://localhost/")
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: { code: 429, message: "busy", status: "RESOURCE_EXHAUSTED" },
    })
  })

  test("returns undefined for unrelated errors", async () => {
    const app = new Hono()
    app.get(
      "/",
      (c) => respondToKnownRouteError(c, new Error("other")) ?? c.text("ok"),
    )

    const response = await app.request("http://localhost/")
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toBe("ok")
  })
})
