import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import {
  WindsurfUpstreamError,
  classifyWindsurfErrorText,
  classifyWindsurfFrameError,
  parseResetsInDuration,
} from "~/services/windsurf/error-classifier"

function utf8(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

afterEach(() => {
  resetAdaptiveRateLimiterForTest()
})

// ── parseResetsInDuration ────────────────────────────────────────────────────

describe("parseResetsInDuration", () => {
  test("parses 3h0m0s → 10800000ms", () => {
    expect(parseResetsInDuration("Resets in: 3h0m0s")).toBe(10_800_000)
  })

  test("parses 1h30m → 5400000ms", () => {
    expect(parseResetsInDuration("Resets in: 1h30m")).toBe(5_400_000)
  })

  test("parses 45m0s → 2700000ms", () => {
    expect(parseResetsInDuration("Resets in: 45m0s")).toBe(2_700_000)
  })

  test("parses 90s → 90000ms", () => {
    expect(parseResetsInDuration("Resets in: 90s")).toBe(90_000)
  })

  test("returns undefined when no duration present", () => {
    expect(parseResetsInDuration("some other error")).toBeUndefined()
  })

  test("returns undefined for zero duration", () => {
    expect(parseResetsInDuration("Resets in: 0h0m0s")).toBeUndefined()
  })
})

// ── classifyWindsurfErrorText ─────────────────────────────────────────────────

describe("classifyWindsurfErrorText", () => {
  test("classifies message rate limit as rate_limited with retryAfterMs", () => {
    const result = classifyWindsurfErrorText(
      "Permission denied",
      "Permission denied: Reached message rate limit for this model. Please try again later. Resets in: 3h0m0s (trace ID: abc)",
    )
    expect(result.kind).toBe("rate_limited")
    expect(result.retryAfterMs).toBe(10_800_000)
    expect(result.code).toBe("Permission denied")
  })

  test("classifies quota exhausted", () => {
    const result = classifyWindsurfErrorText(
      undefined,
      "Quota exhausted: your plan quota has been depleted",
    )
    expect(result.kind).toBe("quota_exhausted")
  })

  test("classifies auth error", () => {
    const result = classifyWindsurfErrorText(
      "Unauthenticated",
      "API key is invalid",
    )
    expect(result.kind).toBe("auth_error")
  })

  test("classifies server error", () => {
    const result = classifyWindsurfErrorText(undefined, "internal server error")
    expect(result.kind).toBe("server_error")
  })

  test("returns unknown for unrecognized messages", () => {
    const result = classifyWindsurfErrorText(undefined, "something else")
    expect(result.kind).toBe("unknown")
  })
})

// ── classifyWindsurfFrameError ───────────────────────────────────────────────

describe("classifyWindsurfFrameError", () => {
  test("parses JSON error frame", () => {
    const frame = utf8(
      JSON.stringify({
        error: {
          code: "Permission denied",
          message:
            "Permission denied: Reached message rate limit for this model. Please try again later. Resets in: 3h0m0s (trace ID: 7f11807f)",
        },
      }),
    )
    const result = classifyWindsurfFrameError(frame)
    expect(result).toBeDefined()
    expect(result?.kind).toBe("rate_limited")
    expect(result?.retryAfterMs).toBe(10_800_000)
    expect(result?.code).toBe("Permission denied")
  })

  test("returns undefined for non-JSON frame", () => {
    const frame = utf8("plain text not json")
    expect(classifyWindsurfFrameError(frame)).toBeUndefined()
  })

  test("returns undefined for JSON without error field", () => {
    const frame = utf8(JSON.stringify({ data: "ok" }))
    expect(classifyWindsurfFrameError(frame)).toBeUndefined()
  })
})

// ── WindsurfUpstreamError ─────────────────────────────────────────────────────

describe("WindsurfUpstreamError", () => {
  test("carries classified metadata", () => {
    const classified = classifyWindsurfErrorText(
      "Permission denied",
      "Reached message rate limit. Resets in: 1h0m0s",
    )
    const err = new WindsurfUpstreamError(classified, new Uint8Array())
    expect(err.name).toBe("WindsurfUpstreamError")
    expect(err.kind).toBe("rate_limited")
    expect(err.retryAfterMs).toBe(3_600_000)
    expect(err.code).toBe("Permission denied")
    expect(err.message).toContain("Windsurf upstream error")
  })
})

// ── fetchWithRetry (transient error retry) ──────────────────────────────────────

describe("windsurf fetchWithRetry", () => {
  const originalFetch = globalThis.fetch
  let fetchCalls: Array<{ status: number } | "network-error">

  beforeEach(() => {
    fetchCalls = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns immediately on 200 OK", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("ok", { status: 200 }),
      )) as unknown as typeof fetch

    const { fetchWithRetry } = await import(
      "~/services/windsurf/create-chat-completions"
    )
    const response = await fetchWithRetry({
      url: "http://test",
      headers: {},
      body: new Uint8Array(),
      accountLabel: "test-account",
    })
    expect(response.ok).toBe(true)
    expect(fetchCalls).toHaveLength(0)
  })

  test("retries on 500 then succeeds", async () => {
    let callCount = 0
    globalThis.fetch = (() => {
      callCount++
      fetchCalls.push({ status: callCount === 1 ? 500 : 200 })
      return Promise.resolve(
        new Response(callCount === 1 ? "err" : "ok", {
          status: callCount === 1 ? 500 : 200,
        }),
      )
    }) as unknown as typeof fetch

    const { fetchWithRetry } = await import(
      "~/services/windsurf/create-chat-completions"
    )
    const response = await fetchWithRetry({
      url: "http://test",
      headers: {},
      body: new Uint8Array(),
      accountLabel: "test-account",
    })
    expect(response.ok).toBe(true)
    expect(callCount).toBe(2)
  })

  test("retries on network error then succeeds", async () => {
    let callCount = 0
    globalThis.fetch = (() => {
      callCount++
      if (callCount === 1) {
        fetchCalls.push("network-error")
        throw new TypeError("fetch failed")
      }
      fetchCalls.push({ status: 200 })
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch

    const { fetchWithRetry } = await import(
      "~/services/windsurf/create-chat-completions"
    )
    const response = await fetchWithRetry({
      url: "http://test",
      headers: {},
      body: new Uint8Array(),
      accountLabel: "test-account",
    })
    expect(response.ok).toBe(true)
    expect(callCount).toBe(2)
  })

  test("throws after exhausting retries on persistent 500", async () => {
    let callCount = 0
    globalThis.fetch = (() => {
      callCount++
      fetchCalls.push({ status: 500 })
      return Promise.resolve(new Response("err", { status: 500 }))
    }) as unknown as typeof fetch

    const { fetchWithRetry, FETCH_MAX_ATTEMPTS } = await import(
      "~/services/windsurf/create-chat-completions"
    )
    let threw = false
    try {
      await fetchWithRetry({
        url: "http://test",
        headers: {},
        body: new Uint8Array(),
        accountLabel: "test-account",
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(callCount).toBe(FETCH_MAX_ATTEMPTS)
  }, 30000)

  test("does NOT retry on 4xx (non-429) — returns response", async () => {
    let callCount = 0
    globalThis.fetch = (() => {
      callCount++
      fetchCalls.push({ status: 400 })
      return Promise.resolve(new Response("bad request", { status: 400 }))
    }) as unknown as typeof fetch

    const { fetchWithRetry } = await import(
      "~/services/windsurf/create-chat-completions"
    )
    const response = await fetchWithRetry({
      url: "http://test",
      headers: {},
      body: new Uint8Array(),
      accountLabel: "test-account",
    })
    expect(response.ok).toBe(false)
    expect(response.status).toBe(400)
    expect(callCount).toBe(1)
  })
})
