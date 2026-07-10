/**
 * Session affinity routing + session id extraction + identity confuse gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { RouteTarget } from "~/lib/provider-connections"

import { applyIdentityConfuseBody } from "~/lib/cache/identity-confuse"
import {
  __resetRouteTargetRoundRobin,
  selectRouteTarget,
  targetKey,
} from "~/lib/route-target"
import {
  CACHE_UTILIZATION_DEFAULTS,
  clearSessionAffinityForTest,
  extractSessionIds,
  generateAntigravityStableSessionId,
  getProviderCacheProfile,
  getSessionAffinitySizeForTest,
  invalidateSessionAffinityAuth,
  isCodexIdentityConfuseEnabled,
  providerHasCacheFeature,
  pruneSessionAffinityForTest,
  resolveStableSessionId,
  setSessionAffinity,
} from "~/lib/routing"
import { state } from "~/lib/state"

function makeTarget(
  connectionId: string,
  credentialId: string,
  priority = 0,
): RouteTarget {
  return {
    connectionId,
    connectionName: connectionId,
    protocol: "openai-compatible",
    credentialId,
    publicModelId: "gpt-test",
    upstreamModelId: "gpt-test",
    endpoint: "chat",
    connectionPriority: priority,
    connectionWeight: 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }
}

function resetRoutingForTest(
  overrides: Partial<typeof CACHE_UTILIZATION_DEFAULTS> = {},
): void {
  state.routing = { ...CACHE_UTILIZATION_DEFAULTS, ...overrides }
}

beforeEach(() => {
  clearSessionAffinityForTest()
  __resetRouteTargetRoundRobin()
  // Tests that need RR explicitly override strategy; production default is
  // fill-first for max cache utilization.
  resetRoutingForTest({ strategy: "round-robin" })
})

afterEach(() => {
  clearSessionAffinityForTest()
  __resetRouteTargetRoundRobin()
  resetRoutingForTest()
})

describe("extractSessionIds", () => {
  test("prefers session header over body prompt_cache_key", () => {
    const ids = extractSessionIds({
      headers: { session_id: "header-session" },
      payload: { prompt_cache_key: "body-cache" },
    })
    expect(ids.primaryId).toBe("header-session")
  })

  test("uses body prompt_cache_key when no session header", () => {
    const ids = extractSessionIds({
      payload: { prompt_cache_key: "body-cache" },
    })
    expect(ids.primaryId).toBe("body-cache")
  })

  test("uses Claude metadata.user_id session suffix", () => {
    const ids = extractSessionIds({
      payload: {
        metadata: {
          user_id: "user_abc_account__session_deadbeef-1234",
        },
      },
    })
    expect(ids.primaryId).toBe("claude:deadbeef-1234")
  })

  test("uses Claude JSON session_id in user_id", () => {
    const ids = extractSessionIds({
      payload: {
        metadata: {
          user_id: JSON.stringify({ session_id: "json-sess-1" }),
        },
      },
    })
    expect(ids.primaryId).toBe("claude:json-sess-1")
  })

  test("falls back to message hash for multi-turn", () => {
    const turn1 = extractSessionIds({
      payload: {
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello world" },
        ],
      },
    })
    expect(turn1.primaryId.startsWith("msg:")).toBe(true)
    expect(turn1.fallbackId).toBe("")

    const turn2 = extractSessionIds({
      payload: {
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello world" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "Next turn" },
        ],
      },
    })
    expect(turn2.primaryId.startsWith("msg:")).toBe(true)
    expect(turn2.fallbackId).toBe(turn1.primaryId)
  })

  test("ignores per-request x-client-request-id for affinity", () => {
    const ids = extractSessionIds({
      headers: { "x-client-request-id": "unique-per-request-uuid" },
      payload: {
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello world" },
        ],
      },
    })
    // Must fall through to message hash, not the unique request id
    expect(ids.primaryId.startsWith("msg:")).toBe(true)
    expect(ids.primaryId).not.toBe("unique-per-request-uuid")
  })

  test("resolveStableSessionId prefers short hash for multi-turn L1 keys", () => {
    const turn1 = extractSessionIds({
      payload: {
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello world" },
        ],
      },
    })
    const turn2 = extractSessionIds({
      payload: {
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello world" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "Next turn" },
        ],
      },
    })
    // L1 Session_id must stay stable across turns (Codex cache)
    expect(resolveStableSessionId(turn1)).toBe(turn1.primaryId)
    expect(resolveStableSessionId(turn2)).toBe(turn1.primaryId)
    expect(resolveStableSessionId(turn2)).toBe(turn2.fallbackId)
    // Primary (full hash) still differs — used only for L0 affinity routing
    expect(turn2.primaryId).not.toBe(turn1.primaryId)
  })
})

describe("selectRouteTarget session affinity", () => {
  test("same session sticks to the same credential", () => {
    const candidates = [
      makeTarget("conn-a", "cred-a"),
      makeTarget("conn-b", "cred-b"),
    ]

    const first = selectRouteTarget(candidates, { sessionId: "sess-1" })
    expect(first).not.toBeNull()
    const second = selectRouteTarget(candidates, { sessionId: "sess-1" })
    expect(second?.connectionId).toBe(first?.connectionId)
    expect(second?.credentialId).toBe(first?.credentialId)

    // Many picks should not rotate away from the sticky binding
    for (let i = 0; i < 10; i++) {
      const again = selectRouteTarget(candidates, { sessionId: "sess-1" })
      expect(again?.credentialId).toBe(first?.credentialId)
    }
  })

  test("different sessions can use different credentials under RR", () => {
    const candidates = [
      makeTarget("conn-a", "cred-a"),
      makeTarget("conn-b", "cred-b"),
    ]
    // Disable affinity and use RR to verify multi-candidate selection works
    state.routing.sessionAffinity = false
    const picks = new Set<string>()
    for (let i = 0; i < 4; i++) {
      const t = selectRouteTarget(candidates)
      if (t) picks.add(targetKey(t))
    }
    expect(picks.size).toBeGreaterThan(1)
  })

  test("fill-first always picks the first sorted credential", () => {
    state.routing.strategy = "fill-first"
    state.routing.sessionAffinity = false
    const candidates = [
      makeTarget("conn-b", "cred-b"),
      makeTarget("conn-a", "cred-a"),
    ]
    for (let i = 0; i < 5; i++) {
      const t = selectRouteTarget(candidates)
      expect(t?.connectionId).toBe("conn-a")
      expect(t?.credentialId).toBe("cred-a")
    }
  })

  test("affinity rebind after exclude selects a new credential", () => {
    const candidates = [
      makeTarget("conn-a", "cred-a"),
      makeTarget("conn-b", "cred-b"),
    ]
    const first = selectRouteTarget(candidates, { sessionId: "sess-rebind" })
    expect(first).not.toBeNull()
    if (!first) return
    const next = selectRouteTarget(candidates, {
      sessionId: "sess-rebind",
      exclude: new Set([targetKey(first)]),
      rebindAffinity: true,
    })
    expect(next).not.toBeNull()
    expect(next?.credentialId).not.toBe(first.credentialId)

    // Subsequent picks stick to the rebound credential
    const again = selectRouteTarget(candidates, { sessionId: "sess-rebind" })
    expect(again?.credentialId).toBe(next?.credentialId)
  })

  test("fallback session id inherits binding from turn-1 short hash", () => {
    const candidates = [
      makeTarget("conn-a", "cred-a"),
      makeTarget("conn-b", "cred-b"),
    ]
    const shortHash = "msg:shorthash000001"
    const fullHash = "msg:fullhash00000001"

    const first = selectRouteTarget(candidates, { sessionId: shortHash })
    expect(first).not.toBeNull()

    const second = selectRouteTarget(candidates, {
      sessionId: fullHash,
      fallbackSessionId: shortHash,
    })
    expect(second?.credentialId).toBe(first?.credentialId)
  })
})

describe("identity confuse gate (Codex-only)", () => {
  test("disabled by default even with affinity", () => {
    state.routing.sessionAffinity = true
    state.routing.identityConfuse = false
    expect(isCodexIdentityConfuseEnabled()).toBe(false)

    const body: Record<string, unknown> = {
      prompt_cache_key: "cache-1",
    }
    const stateOut = applyIdentityConfuseBody("auth-1", body, { ...body })
    expect(stateOut.enabled).toBe(false)
  })

  test("enabled only when flag + affinity (or fill-first)", () => {
    state.routing.identityConfuse = true
    state.routing.sessionAffinity = true
    expect(isCodexIdentityConfuseEnabled()).toBe(true)

    const body: Record<string, unknown> = { prompt_cache_key: "cache-1" }
    const upstream = { ...body }
    const result = applyIdentityConfuseBody("auth-1", body, upstream)
    expect(result.enabled).toBe(true)
    expect(result.promptCacheKey).not.toBe("cache-1")
    expect(upstream.prompt_cache_key).toBe(result.promptCacheKey)

    // Same auth + key → deterministic
    const again = applyIdentityConfuseBody("auth-1", body, { ...body })
    expect(again.promptCacheKey).toBe(result.promptCacheKey)
  })

  test("flag alone without affinity/fill-first is off", () => {
    state.routing.identityConfuse = true
    state.routing.sessionAffinity = false
    state.routing.strategy = "round-robin"
    expect(isCodexIdentityConfuseEnabled()).toBe(false)
  })
})

describe("antigravity stable session id", () => {
  test("is deterministic and CPA-shaped", () => {
    const a = generateAntigravityStableSessionId("hello user")
    const b = generateAntigravityStableSessionId("hello user")
    expect(a).toBe(b)
    expect(a.startsWith("-")).toBe(true)
    expect(/^-?\d+$/.test(a)).toBe(true)
  })
})

describe("cache utilization defaults", () => {
  test("defaults maximize prompt-cache utilization", () => {
    expect(CACHE_UTILIZATION_DEFAULTS.strategy).toBe("fill-first")
    expect(CACHE_UTILIZATION_DEFAULTS.sessionAffinity).toBe(true)
    expect(CACHE_UTILIZATION_DEFAULTS.identityConfuse).toBe(false)
    expect(CACHE_UTILIZATION_DEFAULTS.sessionAffinityTtlMs).toBe(
      2 * 60 * 60_000,
    )
  })

  test("fill-first default sticks new sessions without session id", () => {
    resetRoutingForTest() // production defaults
    const candidates = [
      makeTarget("conn-b", "cred-b"),
      makeTarget("conn-a", "cred-a"),
    ]
    const picks = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const t = selectRouteTarget(candidates)
      if (t) picks.add(`${t.connectionId}::${t.credentialId}`)
    }
    // fill-first: always the sorted-first credential
    expect(picks.size).toBe(1)
    expect([...picks][0]).toBe("conn-a::cred-a")
  })
})

describe("session affinity map maintenance", () => {
  test("invalidateSessionAffinityAuth drops all bindings for an auth key", () => {
    setSessionAffinity("provider::sess-a::model", "conn-a::cred-a")
    setSessionAffinity("provider::sess-b::model", "conn-a::cred-a")
    setSessionAffinity("provider::sess-c::model", "conn-b::cred-b")
    expect(getSessionAffinitySizeForTest()).toBe(3)

    invalidateSessionAffinityAuth("conn-a::cred-a")
    expect(getSessionAffinitySizeForTest()).toBe(1)
  })

  test("prune removes expired entries", () => {
    // Write with normal TTL then force-expire via prune-at-future time is hard
    // without injecting clock into set; instead set then clear via prune of
    // already-expired entries by manually using a past expiresAt through
    // invalidate + re-check size after prune of empty map.
    setSessionAffinity("provider::sess-live::model", "conn-a::cred-a")
    expect(getSessionAffinitySizeForTest()).toBe(1)
    // Nothing expired yet
    expect(pruneSessionAffinityForTest(Date.now() - 1)).toBe(0)
    expect(getSessionAffinitySizeForTest()).toBe(1)
    // Far future: still live (TTL is 2h)
    expect(pruneSessionAffinityForTest(Date.now() + 1000)).toBe(0)
    // Past TTL window
    expect(pruneSessionAffinityForTest(Date.now() + 3 * 60 * 60_000)).toBe(1)
    expect(getSessionAffinitySizeForTest()).toBe(0)
  })
})

describe("provider L1 cache profiles", () => {
  test("identity confuse is codex-only", () => {
    expect(providerHasCacheFeature("codex", "codex-identity-confuse")).toBe(
      true,
    )
    expect(providerHasCacheFeature("claude", "codex-identity-confuse")).toBe(
      false,
    )
    expect(
      providerHasCacheFeature("antigravity", "codex-identity-confuse"),
    ).toBe(false)
    expect(providerHasCacheFeature("xai", "codex-identity-confuse")).toBe(false)
  })

  test("kimi/codebuff only passthrough (no synthesis)", () => {
    expect(getProviderCacheProfile("kimi").synthesizeStableSession).toBe(false)
    expect(getProviderCacheProfile("codebuff").synthesizeStableSession).toBe(
      false,
    )
    expect(getProviderCacheProfile("claude").synthesizeStableSession).toBe(true)
  })
})
