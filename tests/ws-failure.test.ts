import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { ClientAbortError } from "~/lib/request-lifecycle"
import { classifyWsFailure } from "~/services/responses/ws-failure"

/**
 * Mirrors how the low-level upstream-ws generator turns an error / response.failed
 * frame into an HTTPError: `new HTTPError(message, new Response(raw, { status }), raw)`.
 * A frame with no explicit status defaults to 400 (extractWsErrorStatus).
 */
function wsFrameError(
  body: string,
  status: number,
  headers?: Record<string, string>,
): HTTPError {
  return new HTTPError(
    `codex websockets: ${body}`,
    new Response(body, { status, headers }),
    body,
  )
}

describe("classifyWsFailure — abort scope", () => {
  test("AbortError → abort", () => {
    const err = new Error("The operation was aborted")
    err.name = "AbortError"
    expect(classifyWsFailure(err)).toEqual({ scope: "abort", kind: "abort" })
  })

  test("ClientAbortError → abort", () => {
    expect(classifyWsFailure(new ClientAbortError())).toEqual({
      scope: "abort",
      kind: "abort",
    })
  })
})

describe("classifyWsFailure — credential scope", () => {
  test("usage_limit_reached frame with no status (defaults to 400) → quota", () => {
    const body = JSON.stringify({
      type: "response.failed",
      response: { error: { type: "usage_limit_reached" } },
    })
    const result = classifyWsFailure(wsFrameError(body, 400))
    expect(result.scope).toBe("credential")
    expect(result.kind).toBe("quota")
  })

  test("402 payment required → quota", () => {
    const result = classifyWsFailure(wsFrameError("payment required", 402))
    expect(result.scope).toBe("credential")
    expect(result.kind).toBe("quota")
  })

  test("401 → auth", () => {
    const result = classifyWsFailure(wsFrameError("unauthorized", 401))
    expect(result).toMatchObject({ scope: "credential", kind: "auth" })
  })

  test("403 with JSON body → auth", () => {
    const body = JSON.stringify({ error: { message: "forbidden" } })
    const result = classifyWsFailure(wsFrameError(body, 403))
    expect(result).toMatchObject({ scope: "credential", kind: "auth" })
  })

  test("429 transient rate limit → rate with retryAfterMs", () => {
    const result = classifyWsFailure(
      wsFrameError("slow down", 429, { "retry-after": "30" }),
    )
    expect(result.scope).toBe("credential")
    expect(result.kind).toBe("rate")
    expect(result.retryAfterMs).toBe(30_000)
  })

  test("429 with quota body → quota (not rate)", () => {
    const result = classifyWsFailure(
      wsFrameError("insufficient quota balance", 429),
    )
    expect(result).toMatchObject({ scope: "credential", kind: "quota" })
  })

  test("500 → server", () => {
    const result = classifyWsFailure(wsFrameError("upstream boom", 500))
    expect(result).toMatchObject({ scope: "credential", kind: "server" })
  })

  test("503 → server", () => {
    const result = classifyWsFailure(wsFrameError("unavailable", 503))
    expect(result).toMatchObject({ scope: "credential", kind: "server" })
  })
})

describe("classifyWsFailure — request scope (never retry)", () => {
  test("plain 400 invalid request → request, NOT server/500", () => {
    const body = JSON.stringify({
      error: { type: "invalid_request_error", message: "bad input" },
    })
    const result = classifyWsFailure(wsFrameError(body, 400))
    expect(result.scope).toBe("request")
    expect(result.kind).toBe("invalid_request")
    // Regression: a bad request must never be promoted to a 5xx that would
    // poll every account.
    expect(result.kind).not.toBe("server")
  })
})

describe("classifyWsFailure — connection scope (same-account)", () => {
  test("websocket_connection_limit_reached → connection_limit (even on 429)", () => {
    const body = JSON.stringify({
      error: { code: "websocket_connection_limit_reached" },
    })
    const result = classifyWsFailure(wsFrameError(body, 429))
    expect(result).toMatchObject({
      scope: "connection",
      kind: "connection_limit",
    })
  })

  test("previous_response_not_found → connection", () => {
    const body = JSON.stringify({
      error: { message: "previous_response_not_found" },
    })
    const result = classifyWsFailure(wsFrameError(body, 400))
    expect(result).toMatchObject({
      scope: "connection",
      kind: "previous_response_not_found",
    })
  })

  test("Invalid previous_response_id → connection (not request)", () => {
    // ChatGPT 后端有时返回 "Invalid `previous_response_id`." 而不是
    // "previous_response_not_found"，必须识别为 connection scope 以触发
    // transcript replay 恢复，而不是当作普通 bad request 直接抛出。
    const body = JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "Invalid `previous_response_id`.",
      },
    })
    const result = classifyWsFailure(wsFrameError(body, 400))
    expect(result).toMatchObject({
      scope: "connection",
      kind: "previous_response_not_found",
    })
  })

  test("non-HTTPError transport error (socket drop) → transport", () => {
    const result = classifyWsFailure(new Error("socket hang up"))
    expect(result).toEqual({ scope: "connection", kind: "transport" })
  })

  test("first-event timeout (plain Error) → transport", () => {
    const result = classifyWsFailure(
      new Error("codex websockets: timed out waiting for first event"),
    )
    expect(result).toEqual({ scope: "connection", kind: "transport" })
  })
})
