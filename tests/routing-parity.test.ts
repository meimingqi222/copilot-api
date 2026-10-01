/**
 * 路由内核新增能力的回归测试。
 *
 * 覆盖 rest 语义（foreign/proxy/shape/floor + by/failures/link）、rest 注册表
 * （退避、verify 挂起、手动解除）、按模型过滤的额度窗口、turn 稳定键与跨模型
 * 会话亲和回退。
 */
import { beforeEach, describe, expect, test } from "bun:test"

import type { QuotaSnapshot } from "~/lib/quota/types"
import {
  clearRest,
  clearRestRegistryForTest,
  classifyRestReason,
  quotaWindowsOf,
  recordRest,
  renewsAtFor,
  restBackoffMs,
  restDecisionFor,
  restDecisionForReason,
  restInfoFor,
  unrest,
  usedFractionFor,
  verifyHeldError,
  windowAppliesTo,
} from "~/lib/route-target"
import {
  affinityAuthKey,
  affinityCacheKey,
  affinitySessionKey,
  clearSessionAffinityForTest,
  extractSessionTurn,
  getSessionAffinityBySession,
  setSessionAffinity,
} from "~/lib/routing"
import type { RouteTarget } from "~/lib/provider-connections"
import {
  clearTraceBusForTest,
  latestTraceForSession,
  publishTrace,
  traceSeq,
  waitForTraceSeq,
} from "~/lib/trace-bus"

const NOW = 1_800_000_000_000

describe("rest-reason: failure() parity", () => {
  test("a proxy that can't be reached is proxy, not network", () => {
    expect(
      classifyRestReason({
        status: 502,
        body: "proxyconnect tcp: dial tcp 127.0.0.1:7890: connect refused",
      }),
    ).toBe("proxy")
  })

  test("sealed reasoning from another account is foreign", () => {
    expect(
      classifyRestReason({
        status: 400,
        body: JSON.stringify({ error: { code: "invalid_encrypted_content" } }),
      }),
    ).toBe("foreign")
  })

  test("foreign / proxy / shape / floor rest nothing (rotate only)", () => {
    for (const reason of ["foreign", "proxy", "shape", "floor"] as const) {
      const rest = restDecisionForReason({ reason, now: NOW })
      expect(rest.restMs).toBe(0)
      expect(rest.untilMs).toBe(0)
    }
  })

  test("by says what set the duration", () => {
    expect(
      restDecisionFor({ status: 402, body: "{}", fallbackMs: 1000, now: NOW })
        .by,
    ).toBe("credit")
    expect(
      restDecisionFor({
        status: 429,
        body: JSON.stringify({ error: { message: "rate limit exceeded" } }),
        fallbackMs: 1000,
        now: NOW,
      }).by,
    ).toBe("backoff")
    expect(
      restDecisionFor({
        status: 429,
        headers: new Headers({ "retry-after": "30" }),
        body: JSON.stringify({ error: { message: "rate limit exceeded" } }),
        fallbackMs: 1000,
        now: NOW,
      }).by,
    ).toBe("retry-after")
  })

  test("a header wait is capped at an hour", () => {
    const rest = restDecisionFor({
      status: 429,
      headers: new Headers({ "retry-after": "99999" }),
      body: JSON.stringify({ error: { message: "rate limit exceeded" } }),
      fallbackMs: 1000,
      now: NOW,
    })
    expect(rest.restMs).toBe(60 * 60_000)
  })
})

describe("rest-registry", () => {
  beforeEach(() => clearRestRegistryForTest())

  test("backoff grows with consecutive failures and is capped", () => {
    expect(restBackoffMs(1)).toBe(60_000)
    expect(restBackoffMs(2)).toBe(120_000)
    expect(restBackoffMs(3)).toBe(240_000)
    expect(restBackoffMs(20)).toBe(10 * 60_000)
  })

  test("a network rest's duration is the backoff", () => {
    const first = recordRest({
      credentialId: "c1",
      reason: "network",
      by: "backoff",
      untilMs: NOW + 10 * 60_000,
      now: NOW,
    })
    expect(first.failures).toBe(1)
    expect(first.by).toBe("backoff")
    const second = recordRest({
      credentialId: "c1",
      reason: "network",
      by: "backoff",
      untilMs: NOW + 10 * 60_000,
      now: NOW,
    })
    expect(second.failures).toBe(2)
    // capped to the second failure's backoff (2 minutes), not the 10 asked
    expect(second.untilMs).toBe(NOW + 120_000)
  })

  test("a verify refusal is held and answered from memory", () => {
    recordRest({
      credentialId: "c2",
      reason: "verify",
      by: "verify",
      untilMs: NOW + 30 * 60_000,
      said: "VALIDATION_REQUIRED",
      now: NOW,
    })
    expect(verifyHeldError("c2", undefined, NOW + 1000)).toBe(
      "VALIDATION_REQUIRED",
    )
    // past the short hold, upstream is asked again
    expect(verifyHeldError("c2", undefined, NOW + 61_000)).toBeUndefined()
  })

  test("unrest lifts a rest by key", () => {
    const info = recordRest({
      credentialId: "c3",
      reason: "credit",
      by: "credit",
      untilMs: NOW + 30 * 60_000,
      now: NOW,
    })
    expect(restInfoFor("c3", undefined)).toBeDefined()
    expect(unrest(info.key as string)).toBe(true)
    expect(restInfoFor("c3", undefined)).toBeUndefined()
    expect(unrest(info.key as string)).toBe(false)
  })

  test("clearing a rest by credential id lifts it", () => {
    recordRest({
      credentialId: "c4",
      reason: "rate",
      by: "retry-after",
      untilMs: NOW + 5000,
      now: NOW,
    })
    clearRest("c4")
    expect(restInfoFor("c4", undefined)).toBeUndefined()
  })
})

describe("evidence: model-scoped allowance windows", () => {
  const now = Date.now()
  const snapshot: QuotaSnapshot = {
    fetchedAt: now,
    unlimited: false,
    details: {
      _quotaWindows: [
        {
          id: "seven_day_opus",
          labelKey: "quota.oauth.claude.sevenDayOpus",
          usedPercent: 100,
          windowStartMs: now,
          windowEndMs: now + 7 * 24 * 3_600_000,
        },
        {
          id: "five_hour",
          labelKey: "quota.oauth.claude.fiveHour",
          usedPercent: 10,
          windowStartMs: now,
          windowEndMs: now + 5 * 3_600_000,
        },
      ],
    },
  }

  test("windows carry their model scope", () => {
    const windows = quotaWindowsOf(snapshot)
    expect(windows.length).toBe(2)
    expect(windows[0]?.scope).toBe("opus")
    expect(windows[1]?.scope).toBeUndefined()
  })

  test("a plan-wide window counts every model", () => {
    const fiveHour = quotaWindowsOf(snapshot)[1]!
    expect(windowAppliesTo(fiveHour, "claude-opus-4-8")).toBe(true)
    expect(windowAppliesTo(fiveHour, "claude-sonnet-4")).toBe(true)
  })

  test("an Opus window doesn't weigh Sonnet", () => {
    expect(usedFractionFor(snapshot, "claude-opus-4-8")).toBe(1)
    expect(usedFractionFor(snapshot, "claude-sonnet-4")).toBe(0.1)
  })

  test("renewals come from the windows that count the model", () => {
    // Every window that counts the model, biggest window first: Opus sees its
    // own weekly window ahead of the plan-wide five-hour one.
    const opus = renewsAtFor(snapshot, "claude-opus-4-8")
    expect(opus).toEqual([now + 7 * 24 * 3_600_000, now + 5 * 3_600_000])
    // Sonnet is not counted by the Opus window: only the five-hour one.
    const sonnet = renewsAtFor(snapshot, "claude-sonnet-4")
    expect(sonnet).toEqual([now + 5 * 3_600_000])
  })

  test("no per-window data falls back to the snapshot's counters", () => {
    const plain: QuotaSnapshot = {
      fetchedAt: now,
      unlimited: false,
      chatRemaining: 0,
      chatTotal: 100,
    }
    expect(usedFractionFor(plain, "anything")).toBe(1)
  })
})

describe("session-extract: turn key", () => {
  const userText = { role: "user", content: "write a test" }
  const assistant = { role: "assistant", content: "ok" }
  const toolResult = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
  }

  test("a new turn is not mid-turn", () => {
    const turn = extractSessionTurn({ messages: [userText] })
    expect(turn.within).toBe(false)
    expect(turn.turnKey.startsWith("turn:")).toBe(true)
  })

  test("tool-result rounds share one turn key", () => {
    const first = extractSessionTurn({ messages: [userText, assistant] })
    const second = extractSessionTurn({
      messages: [userText, assistant, toolResult],
    })
    expect(second.turnKey).toBe(first.turnKey)
    expect(second.within).toBe(true)
  })

  test("the next user message is a new turn", () => {
    const first = extractSessionTurn({
      messages: [userText, assistant, toolResult],
    })
    const next = extractSessionTurn({
      messages: [
        userText,
        assistant,
        toolResult,
        { role: "user", content: "now add a case" },
      ],
    })
    expect(next.turnKey).not.toBe(first.turnKey)
    expect(next.within).toBe(false)
  })
})

describe("session-affinity: cross-model fallback", () => {
  beforeEach(() => clearSessionAffinityForTest())

  const target = (modelId: string): RouteTarget =>
    ({
      connectionId: "conn1",
      credentialId: "cred1",
      publicModelId: modelId,
      protocol: "anthropic-compatible",
    }) as unknown as RouteTarget

  test("a session keeps its account when the model changes", () => {
    const opus = target("claude-opus-4-8")
    const sessionKey = affinitySessionKey("sess-1", opus.protocol)
    setSessionAffinity(
      affinityCacheKey("sess-1", "claude-opus-4-8", opus.protocol),
      affinityAuthKey(opus),
      { sessionKey },
    )
    // Sonnet's own binding doesn't exist yet; the session index still knows.
    expect(getSessionAffinityBySession(sessionKey)).toBe(affinityAuthKey(opus))
  })
})

describe("trace-bus: per-session route", () => {
  beforeEach(() => clearTraceBusForTest())

  test("the latest trace for a session is returned with its seq", () => {
    publishTrace({ requestId: "r1", sessionId: "sess-a", model: "m1" }, "final")
    publishTrace({ requestId: "r2", sessionId: "sess-b", model: "m2" }, "final")
    const found = latestTraceForSession("sess-a")
    expect(found.seq).toBeGreaterThan(0)
    expect(found.entry?.model).toBe("m1")
    expect(latestTraceForSession("missing").entry).toBeUndefined()
  })

  test("waiting past a seq resolves once a trace is published", async () => {
    const before = traceSeq()
    const waiting = waitForTraceSeq(before, 1000)
    publishTrace({ requestId: "r3", sessionId: "sess-c" }, "start")
    await waiting
    expect(traceSeq()).toBeGreaterThan(before)
  })

  test("waiting resolves on timeout when nothing is published", async () => {
    const before = traceSeq()
    await waitForTraceSeq(before, 10)
    expect(traceSeq()).toBe(before)
  })
})
