import { beforeEach, describe, expect, test } from "bun:test"

import {
  clearCloudSessionCache,
  getOrAllocateCloudSessionIds,
  resetCloudSessionCacheForTest,
  resolveWindsurfConversationKey,
} from "~/services/windsurf/session-cache"

const HOST = "https://server.self-serve.windsurf.com"

beforeEach(() => {
  resetCloudSessionCacheForTest()
})

describe("windsurf session cache", () => {
  test("reuses stable session and cascade ids per host+apiKey+conversation", async () => {
    const first = await getOrAllocateCloudSessionIds({
      host: HOST,
      apiKey: "key-a",
      conversationKey: "conv-1",
    })
    const second = await getOrAllocateCloudSessionIds({
      host: HOST,
      apiKey: "key-a",
      conversationKey: "conv-1",
    })
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.cascadeId).toBe(first.cascadeId)
  })

  test("isolates ids by api key, host, and conversation", async () => {
    const a = await getOrAllocateCloudSessionIds({
      host: HOST,
      apiKey: "key-a",
      conversationKey: "conv-1",
    })
    const b = await getOrAllocateCloudSessionIds({
      host: HOST,
      apiKey: "key-b",
      conversationKey: "conv-1",
    })
    const c = await getOrAllocateCloudSessionIds({
      host: HOST,
      apiKey: "key-a",
      conversationKey: "conv-2",
    })
    expect(b.sessionId).not.toBe(a.sessionId)
    expect(c.sessionId).not.toBe(a.sessionId)
    expect(c.cascadeId).not.toBe(a.cascadeId)
  })

  test("prefers forwarded session headers", async () => {
    const key = await resolveWindsurfConversationKey({
      forwardedHeaders: { "x-windsurf-session-id": "  session-abc  " },
      accountId: "acct-1",
    })
    expect(key).toBe("session-abc")
  })

  test("uses body prompt_cache_key when headers absent", async () => {
    const key = await resolveWindsurfConversationKey({
      promptCacheKey: "cache-body-1",
      accountId: "acct-1",
    })
    expect(key).toBe("cache-body-1")
  })

  test("uses OpenAI user field before account fallback", async () => {
    const key = await resolveWindsurfConversationKey({
      user: "end-user-42",
      accountId: "acct-1",
    })
    expect(key).toBe("user:end-user-42")
  })

  test("auto-generates stable key per account when client sends nothing", async () => {
    const first = await resolveWindsurfConversationKey({
      accountId: "acct-stable-a",
    })
    const second = await resolveWindsurfConversationKey({
      accountId: "acct-stable-a",
    })
    const other = await resolveWindsurfConversationKey({
      accountId: "acct-stable-b",
    })
    expect(first).toBe(second)
    expect(other).not.toBe(first)
    expect(first).not.toBe("__default__")
  })

  test("clearCloudSessionCache drops only matching conversation suffix", async () => {
    const before = await getOrAllocateCloudSessionIds({
      host: HOST,
      apiKey: "key-a",
      conversationKey: "conv-1",
    })
    const other = await getOrAllocateCloudSessionIds({
      host: HOST,
      apiKey: "key-a",
      conversationKey: "conv-2",
    })
    clearCloudSessionCache("conv-1")
    const after = await getOrAllocateCloudSessionIds({
      host: HOST,
      apiKey: "key-a",
      conversationKey: "conv-1",
    })
    const otherAgain = await getOrAllocateCloudSessionIds({
      host: HOST,
      apiKey: "key-a",
      conversationKey: "conv-2",
    })
    expect(after.sessionId).not.toBe(before.sessionId)
    expect(otherAgain.sessionId).toBe(other.sessionId)
  })
})
