import { beforeEach, describe, expect, test } from "bun:test"

import {
  clearCloudSessionCache,
  devinSessionUuid,
  getOrAllocateCloudSessionIds,
  resetCloudSessionCacheForTest,
  resolveWindsurfConversationKey,
} from "~/services/windsurf/session-cache"

beforeEach(() => {
  resetCloudSessionCacheForTest()
})

describe("windsurf session cache", () => {
  test("reuses stable cascade and prompt ids per account+conversation", async () => {
    const first = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-1",
    })
    const second = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-1",
    })
    expect(second.cascadeId).toBe(first.cascadeId)
    expect(second.promptId).toBe(first.promptId)
  })

  test("derives the same ids with no cached state at all", async () => {
    // Regression: the cascade used to be a per-process `randomUUID()` stored in
    // a JSON file. Every worker (and every restart) that had not read that file
    // invented its own cascade, and the upstream scopes its KV cache for the
    // `swe-*` models to the cascade — so the cache was split across workers and
    // the hit rate fell to roughly 1/worker. Derivation must not need the map.
    const warm = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-deterministic",
      accountId: "acct-1",
    })
    resetCloudSessionCacheForTest() // simulates a second worker / a cold start
    const cold = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-deterministic",
      accountId: "acct-1",
    })
    expect(cold.cascadeId).toBe(warm.cascadeId)
    expect(cold.promptId).toBe(warm.promptId)
  })

  test("keeps the cascade across a credential refresh", async () => {
    const before = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-1",
      accountId: "acct-1",
    })
    const after = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-1",
      accountId: "acct-1",
    })
    expect(after.cascadeId).toBe(before.cascadeId)
  })

  test("isolates ids by account and conversation", async () => {
    const a = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-1",
      accountId: "acct-1",
    })
    const b = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-1",
      accountId: "acct-2",
    })
    const c = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-2",
      accountId: "acct-1",
    })
    expect(b.cascadeId).not.toBe(a.cascadeId)
    expect(c.cascadeId).not.toBe(a.cascadeId)
    expect(c.promptId).not.toBe(a.promptId)
  })

  test("passes a UUID conversation key through verbatim", () => {
    const id = "01a0dcb1-3f81-77a7-a7d2-75cb61837e40"
    expect(devinSessionUuid(id)).toBe(id)
    expect(devinSessionUuid(id.toUpperCase())).toBe(id)
  })

  test("maps a non-UUID conversation key to a stable RFC 4122 UUID v5", () => {
    const mapped = devinSessionUuid("zcode:conversation-7")
    expect(mapped).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(devinSessionUuid("zcode:conversation-7")).toBe(mapped)
    expect(devinSessionUuid("zcode:conversation-8")).not.toBe(mapped)
  })

  test("prefers forwarded session headers", () => {
    const key = resolveWindsurfConversationKey({
      forwardedHeaders: { "x-windsurf-session-id": "  session-abc  " },
      accountId: "acct-1",
    })
    expect(key).toEqual({ key: "session-abc", persistent: true })
  })

  test("uses Claude Code session headers for Messages requests", () => {
    const key = resolveWindsurfConversationKey({
      forwardedHeaders: {
        "x-claude-code-session-id": "claude-session-1",
      },
    })
    expect(key).toEqual({ key: "claude-session-1", persistent: true })
  })

  test("uses body prompt_cache_key when headers absent", () => {
    const key = resolveWindsurfConversationKey({
      promptCacheKey: "cache-body-1",
      accountId: "acct-1",
    })
    expect(key).toEqual({ key: "cache-body-1", persistent: true })
  })

  test("uses generic x-session-id header (ZCode conversation id)", () => {
    const key = resolveWindsurfConversationKey({
      forwardedHeaders: { "x-session-id": "zcode-conv-1" },
      accountId: "acct-1",
    })
    expect(key).toEqual({ key: "zcode-conv-1", persistent: true })
  })

  test("windsurf-specific header wins over generic x-session-id", () => {
    const key = resolveWindsurfConversationKey({
      forwardedHeaders: {
        "x-windsurf-session-id": "explicit-ws",
        "x-session-id": "zcode-conv-1",
      },
    })
    expect(key).toEqual({ key: "explicit-ws", persistent: true })
  })

  test("does not use OpenAI user as an implicit conversation identity", () => {
    const key = resolveWindsurfConversationKey({
      user: "end-user-42",
      accountId: "acct-1",
    })
    expect(key.key).not.toBe("user:end-user-42")
    expect(key.key).toMatch(/^[0-9a-f-]{36}$/)
    expect(key.persistent).toBe(false)
  })

  test("uses a fresh key when client sends no conversation identity", () => {
    const first = resolveWindsurfConversationKey({
      accountId: "acct-stable-a",
    })
    const second = resolveWindsurfConversationKey({
      accountId: "acct-stable-a",
    })
    expect(first.key).not.toBe(second.key)
    expect(first.key).not.toBe("__default__")
    expect(first.persistent).toBe(false)
    expect(second.persistent).toBe(false)
  })

  test("does not persist request-scoped session ids", async () => {
    const firstKey = resolveWindsurfConversationKey({}).key
    const secondKey = resolveWindsurfConversationKey({}).key
    const first = await getOrAllocateCloudSessionIds({
      conversationKey: firstKey,
      persist: false,
    })
    const second = await getOrAllocateCloudSessionIds({
      conversationKey: secondKey,
      persist: false,
    })

    // Each request-scoped key is its own bucket, so it must not reuse the
    // previous request's cascade.
    expect(second.cascadeId).not.toBe(first.cascadeId)
  })

  test("clearCloudSessionCache drops only matching conversation suffix", async () => {
    const before = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-1",
    })
    const other = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-2",
    })
    clearCloudSessionCache("conv-1")
    const after = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-1",
    })
    const otherAgain = await getOrAllocateCloudSessionIds({
      conversationKey: "conv-2",
    })
    expect(after.cascadeId).not.toBe(before.cascadeId)
    expect(otherAgain.cascadeId).toBe(other.cascadeId)
  })
})
