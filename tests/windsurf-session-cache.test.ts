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
  test("reuses stable cascade and prompt ids per host+apiKey+conversation", async () => {
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
    expect(second.cascadeId).toBe(first.cascadeId)
    expect(second.promptId).toBe(first.promptId)
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
    expect(b.cascadeId).not.toBe(a.cascadeId)
    expect(c.cascadeId).not.toBe(a.cascadeId)
    expect(c.promptId).not.toBe(a.promptId)
  })

  test("prefers forwarded session headers", () => {
    const key = resolveWindsurfConversationKey({
      forwardedHeaders: { "x-windsurf-session-id": "  session-abc  " },
      accountId: "acct-1",
    })
    expect(key).toBe("session-abc")
  })

  test("uses body prompt_cache_key when headers absent", () => {
    const key = resolveWindsurfConversationKey({
      promptCacheKey: "cache-body-1",
      accountId: "acct-1",
    })
    expect(key).toBe("cache-body-1")
  })

  test("does not use OpenAI user as an implicit conversation identity", () => {
    const key = resolveWindsurfConversationKey({
      user: "end-user-42",
      accountId: "acct-1",
    })
    expect(key).not.toBe("user:end-user-42")
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("uses a fresh key when client sends no conversation identity", () => {
    const first = resolveWindsurfConversationKey({
      accountId: "acct-stable-a",
    })
    const second = resolveWindsurfConversationKey({
      accountId: "acct-stable-a",
    })
    expect(first).not.toBe(second)
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
    expect(after.cascadeId).not.toBe(before.cascadeId)
    expect(otherAgain.cascadeId).toBe(other.cascadeId)
  })
})
