/**
 * 额度用尽(Codex 的 usage_limit_reached)在客户端侧的改写。
 *
 * Codex 把 `usage_limit_reached` 当终态:本轮直接结束,5 小时窗口恢复后也
 * 不会自动继续。同一个拒绝按 429 + `rate_limit_exceeded` + `Retry-After`
 * 交出去,它就会等到重置时刻再发同一轮。这里锁住三条:
 * - 说了重置时刻 → 改写,Retry-After 就是那一刻;
 * - 没说 → 保持原样(别让客户端按本地猜的窗口长睡);
 * - 不是额度用尽 → 一个字都不动。
 */

import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { HTTPError, forwardError } from "~/lib/error"
import { retryableUsageLimit, usageLimitResetMs } from "~/lib/usage-limit"

function wire(error: HTTPError, path = "/v1/responses") {
  const app = new Hono()
  app.all(path, (c) => {
    try {
      throw error
    } catch (thrown) {
      return forwardError(c, thrown)
    }
  })
  return app.request(`http://localhost${path}`, { method: "POST" })
}

function usageLimitError(
  body: string,
  options: { status?: number; headers?: Record<string, string> } = {},
): HTTPError {
  return new HTTPError(
    "Failed to create Codex responses",
    new Response(null, {
      status: options.status ?? 429,
      headers: options.headers,
    }),
    body,
  )
}

const FIVE_HOURS = 5 * 60 * 60

describe("retryableUsageLimit", () => {
  test("dates the reset from resets_at and rewrites the type", () => {
    const now = 1_700_000_000_000
    const result = retryableUsageLimit({
      status: 429,
      body: JSON.stringify({
        error: {
          type: "usage_limit_reached",
          message: "You've hit your usage limit.",
          resets_at: Math.floor(now / 1000) + FIVE_HOURS,
          plan_type: "plus",
        },
      }),
      now,
    })
    expect(result?.status).toBe(429)
    expect(result?.retryAfterMs).toBe(FIVE_HOURS * 1000)
    expect(JSON.parse(result!.body)).toEqual({
      error: {
        message: "You've hit your usage limit.",
        type: "rate_limit_exceeded",
        param: null,
        code: "rate_limit_exceeded",
      },
    })
  })

  test("reads resets_in_seconds", () => {
    const result = retryableUsageLimit({
      status: 429,
      body: JSON.stringify({
        error: { type: "usage_limit_reached", resets_in_seconds: 90 },
      }),
    })
    expect(result?.retryAfterMs).toBe(90_000)
  })

  test("reads a millisecond resets_at without treating it as seconds", () => {
    const now = 1_700_000_000_000
    const result = retryableUsageLimit({
      status: 429,
      body: JSON.stringify({
        error: { type: "usage_limit_reached", resets_at: now + 90_000 },
      }),
      now,
    })
    expect(result?.retryAfterMs).toBe(90_000)
  })

  test("reads a streamed response.error payload", () => {
    const result = retryableUsageLimit({
      status: 429,
      body: JSON.stringify({
        type: "response.failed",
        response: {
          error: {
            type: "usage_limit_reached",
            message: "quota exhausted",
            resets_in_seconds: 600,
          },
        },
      }),
    })
    expect(result?.retryAfterMs).toBe(600_000)
    expect(JSON.parse(result!.body).error.type).toBe("rate_limit_exceeded")
  })

  test("falls back to the upstream Retry-After when the body dates nothing", () => {
    const result = retryableUsageLimit({
      status: 429,
      body: JSON.stringify({
        error: { type: "usage_limit_reached", message: "out of quota" },
      }),
      retryAfterHeader: "120",
    })
    expect(result?.retryAfterMs).toBe(120_000)
  })

  test("leaves an undated usage limit alone (stays terminal)", () => {
    expect(
      retryableUsageLimit({
        status: 429,
        body: JSON.stringify({
          error: { type: "usage_limit_reached", message: "out of quota" },
        }),
      }),
    ).toBeUndefined()
  })

  test("leaves other rate limits alone", () => {
    expect(
      retryableUsageLimit({
        status: 429,
        body: JSON.stringify({
          error: { type: "rate_limit_exceeded", resets_in_seconds: 5 },
        }),
      }),
    ).toBeUndefined()
  })

  test("promotes a 400 usage-limit refusal to 429", () => {
    const result = retryableUsageLimit({
      status: 400,
      body: JSON.stringify({
        error: { type: "usage_limit_reached", resets_in_seconds: 30 },
      }),
    })
    expect(result?.status).toBe(429)
  })

  test("shapes the body for an Anthropic client", () => {
    const result = retryableUsageLimit({
      status: 429,
      body: JSON.stringify({
        error: { type: "usage_limit_reached", resets_in_seconds: 30 },
      }),
      anthropic: true,
    })
    expect(JSON.parse(result!.body)).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "usage limit reached" },
    })
  })
})

describe("usageLimitResetMs", () => {
  test("parses the reset written in the message", () => {
    const at = new Date(Date.now() + 2 * 3600 * 1000)
    const pad = (n: number) => String(n).padStart(2, "0")
    const wallClock = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(
      at.getUTCDate(),
    )} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
    const ms = usageLimitResetMs(
      JSON.stringify({
        error: {
          type: "usage_limit_reached",
          message: `It will reset at ${wallClock} +0000 UTC.`,
        },
      }),
    )
    expect(ms).toBeGreaterThan(2 * 3600 * 1000 - 5_000)
    expect(ms).toBeLessThanOrEqual(2 * 3600 * 1000)
  })

  test("is undefined without a dated reset", () => {
    expect(
      usageLimitResetMs(
        JSON.stringify({ error: { type: "usage_limit_reached" } }),
      ),
    ).toBeUndefined()
  })
})

describe("forwardError wire shape", () => {
  test("a dated usage limit reaches the client as a retryable 429", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + FIVE_HOURS
    const response = await wire(
      usageLimitError(
        JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "You've hit your usage limit.",
            resets_at: resetAt,
          },
        }),
      ),
    )
    expect(response.status).toBe(429)
    expect(response.headers.get("content-type")).toBe("application/json")
    const retryAfter = Number(response.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(FIVE_HOURS - 5)
    expect(retryAfter).toBeLessThanOrEqual(FIVE_HOURS)
    expect(await response.json()).toEqual({
      error: {
        message: "You've hit your usage limit.",
        type: "rate_limit_exceeded",
        param: null,
        code: "rate_limit_exceeded",
      },
    })
  })

  test("the body's reset outranks a shorter upstream Retry-After", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + FIVE_HOURS
    const response = await wire(
      usageLimitError(
        JSON.stringify({
          error: { type: "usage_limit_reached", resets_at: resetAt },
        }),
        { headers: { "Retry-After": "60" } },
      ),
    )
    expect(response.status).toBe(429)
    const retryAfter = Number(response.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(FIVE_HOURS - 5)
    expect(retryAfter).toBeLessThanOrEqual(FIVE_HOURS)
  })

  test("an undated usage limit is passed through untouched", async () => {
    const body = JSON.stringify({
      error: { type: "usage_limit_reached", message: "out of quota" },
    })
    const response = await wire(usageLimitError(body))
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBeNull()
    expect(await response.json()).toEqual(JSON.parse(body))
  })

  test("an Anthropic client gets Anthropic's rate-limit shape", async () => {
    const response = await wire(
      usageLimitError(
        JSON.stringify({
          error: { type: "usage_limit_reached", resets_in_seconds: 60 },
        }),
      ),
      "/v1/messages",
    )
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "usage limit reached" },
    })
  })

  test("ordinary upstream errors keep their body", async () => {
    const body = JSON.stringify({
      error: { type: "rate_limit_exceeded", message: "slow down" },
    })
    const response = await wire(usageLimitError(body))
    expect(await response.json()).toEqual(JSON.parse(body))
  })
})

describe("ws error frame", () => {
  test("a dated usage limit becomes a retryable frame", async () => {
    const { handleResponseError } = await import("~/routes/responses/ws-error")
    const frames: Array<string> = []
    const ws = {
      readyState: 1,
      send: (data: string | ArrayBuffer | Uint8Array) => {
        frames.push(String(data))
      },
    }
    await handleResponseError(
      ws,
      usageLimitError(
        JSON.stringify({
          error: { type: "usage_limit_reached", resets_in_seconds: 120 },
        }),
      ),
      new AbortController().signal,
    )

    expect(frames).toHaveLength(1)
    const frame = JSON.parse(frames[0]) as {
      status: number
      headers: Record<string, string>
      error: { type: string; code: string }
    }
    expect(frame.status).toBe(429)
    expect(frame.error.type).toBe("rate_limit_exceeded")
    expect(frame.error.code).toBe("rate_limit_exceeded")
    expect(Number(frame.headers["Retry-After"])).toBe(120)
  })
})
