/**
 * 失败语义分档（Phase 3）：rest-reason 分类器与时长表。
 *
 * 对齐 magpie routing.go 的 failure()/restAfter()：靠厂商措辞（而非仅
 * 状态码）区分 credit / quota / rate / verify / refused，并按档给时长，
 * quota 读真实重置窗口（封顶 8d），refused 不休息。
 */
import { describe, expect, test } from "bun:test"

import {
  classifyRestReason,
  restDecisionFor,
  restDecisionForReason,
} from "~/lib/route-target"

const NOW = 1_800_000_000_000

describe("classifyRestReason", () => {
  test("402 is credit", () => {
    expect(classifyRestReason({ status: 402, body: "{}" })).toBe("credit")
  })

  test("balance words are credit even without a 402", () => {
    expect(
      classifyRestReason({
        status: 400,
        body: JSON.stringify({ error: { message: "Insufficient balance" } }),
      }),
    ).toBe("credit")
  })

  test("a short rate limit stays rate, not quota", () => {
    expect(
      classifyRestReason({
        status: 429,
        body: JSON.stringify({ error: { message: "Rate limit exceeded" } }),
      }),
    ).toBe("rate")
  })

  test("a 429 that names the plan's allowance is quota", () => {
    expect(
      classifyRestReason({
        status: 429,
        body: JSON.stringify({
          error: { message: "Daily usage limit reached" },
        }),
      }),
    ).toBe("quota")
  })

  test("verification words on 401/403 are verify", () => {
    expect(
      classifyRestReason({
        status: 403,
        body: JSON.stringify({ error: { message: "VALIDATION_REQUIRED" } }),
      }),
    ).toBe("verify")
  })

  test("a plain 401 is not a rest reason of its own", () => {
    expect(
      classifyRestReason({
        status: 401,
        body: JSON.stringify({ error: { message: "Unauthorized" } }),
      }),
    ).toBe("unknown")
  })

  test("safety-filter refusals are refused", () => {
    expect(
      classifyRestReason({
        status: 400,
        body: "Illegal API invocation from an unapproved channel",
      }),
    ).toBe("refused")
  })
})

describe("restDecisionFor durations", () => {
  test("credit rests 30 minutes", () => {
    const rest = restDecisionFor({
      status: 402,
      body: "{}",
      fallbackMs: 60_000,
      now: NOW,
    })
    expect(rest.reason).toBe("credit")
    expect(rest.restMs).toBe(30 * 60_000)
    expect(rest.untilMs).toBe(NOW + 30 * 60_000)
  })

  test("quota reads Claude Code's 'limit reached|<unix>' window", () => {
    const resetAt = Math.floor(NOW / 1000) + 3 * 3600
    const rest = restDecisionFor({
      status: 429,
      body: `usage limit reached|${resetAt}`,
      fallbackMs: 60_000,
      now: NOW,
    })
    expect(rest.reason).toBe("quota")
    expect(rest.restMs).toBe(3 * 3_600_000)
    expect(rest.resetAtMs).toBe(resetAt * 1000)
  })

  test("quota reads Codex resets_at and caps at 8 days", () => {
    const resetAt = Math.floor(NOW / 1000) + 30 * 24 * 3600 // 30 days out
    const rest = restDecisionFor({
      status: 429,
      body: JSON.stringify({
        error: { type: "usage_limit_reached", resets_at: resetAt },
      }),
      fallbackMs: 60_000,
      now: NOW,
    })
    expect(rest.reason).toBe("quota")
    expect(rest.restMs).toBe(8 * 24 * 3_600_000)
  })

  test("quota with no word of when floors at 15 minutes", () => {
    const rest = restDecisionFor({
      status: 429,
      body: JSON.stringify({ error: { message: "usage limit reached" } }),
      fallbackMs: 60_000,
      now: NOW,
    })
    expect(rest.reason).toBe("quota")
    expect(rest.restMs).toBe(15 * 60_000)
  })

  test("rate trusts Retry-After over the fallback", () => {
    const rest = restDecisionFor({
      status: 429,
      headers: new Headers({ "retry-after": "42" }),
      body: JSON.stringify({ error: { message: "rate limit exceeded" } }),
      fallbackMs: 60_000,
      now: NOW,
    })
    expect(rest.reason).toBe("rate")
    expect(rest.restMs).toBe(42_000)
  })

  test("rate falls back to the backoff when told nothing", () => {
    const rest = restDecisionFor({
      status: 429,
      body: JSON.stringify({ error: { message: "too many requests" } }),
      fallbackMs: 7_000,
      now: NOW,
    })
    expect(rest.reason).toBe("rate")
    expect(rest.restMs).toBe(7_000)
  })

  test("verify rests 30 minutes", () => {
    const rest = restDecisionFor({
      status: 403,
      body: JSON.stringify({ error: { message: "VALIDATION_REQUIRED" } }),
      fallbackMs: 60_000,
      now: NOW,
    })
    expect(rest.reason).toBe("verify")
    expect(rest.restMs).toBe(30 * 60_000)
  })

  test("refused rests nothing", () => {
    const rest = restDecisionFor({
      status: 400,
      body: "blocked by security policy",
      fallbackMs: 60_000,
      now: NOW,
    })
    expect(rest.reason).toBe("refused")
    expect(rest.restMs).toBe(0)
    expect(rest.untilMs).toBe(0)
  })

  test("a 5xx rests the backoff (network)", () => {
    const rest = restDecisionFor({
      status: 503,
      body: "upstream down",
      fallbackMs: 30_000,
      now: NOW,
    })
    expect(rest.reason).toBe("network")
    expect(rest.restMs).toBe(30_000)
  })

  test("restDecisionForReason maps a known Windsurf kind", () => {
    const rest = restDecisionForReason({
      reason: "rate",
      retryAfterMs: 10_800_000, // Windsurf "Resets in: 3h0m0s"
      fallbackMs: 60_000,
      now: NOW,
    })
    expect(rest.restMs).toBe(10_800_000)
  })
})
