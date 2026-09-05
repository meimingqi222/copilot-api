import type { Context } from "hono"

import { beforeEach, describe, expect, test } from "bun:test"

import { statsStore } from "~/lib/stats-store"
import {
  recordDirectStreamingUsage,
  recordStreamingUsage,
  updateLastUsage,
} from "~/routes/messages/usage-recorder"

function fakeContext(model: string): Context {
  const store: Record<string, unknown> = { model }
  return {
    get: (key: string) => store[key],
    set: (key: string, value: unknown) => {
      store[key] = value
    },
  } as unknown as Context
}

function modelEntry(accountId = "acc-1", model = "test-model") {
  const date = statsStore.getDateString(Date.now())
  return statsStore.getUsageStats(accountId, date, date)[0]?.models[model]
}

function rowCount(accountId = "acc-1"): number {
  const date = statsStore.getDateString(Date.now())
  return statsStore
    .getUsageStats(accountId, date, date)
    .reduce((n, s) => n + Object.keys(s.models).length, 0)
}

describe("recordStreamingUsage (copilot/OpenAI shape)", () => {
  beforeEach(() => {
    statsStore.clearUsageStatsForTest()
    statsStore.setModelPricing("test-model", {
      promptPricePer1k: 0.01,
      completionPricePer1k: 0.02,
      cacheReadPricePer1k: 0.001,
      cacheWritePricePer1k: 0.005,
    })
  })

  test("cache creation is excluded from prompt tokens (no double-bill)", () => {
    // prompt_tokens 是总量(含 200 缓存读 + 100 缓存写)。
    recordStreamingUsage(fakeContext("test-model"), "acc-1", {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_tokens_details: {
        cached_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    })

    const date = statsStore.getDateString(Date.now())
    const stats = statsStore.getUsageStats("acc-1", date, date)
    const entry = stats[0]?.models["test-model"]
    expect(entry).toBeDefined()
    // 1000 - 200 - 100 = 700;缓存写只按 cache-write 价算一次。
    expect(entry?.promptTokens).toBe(700)
    expect(entry?.cacheReadTokens).toBe(200)
    expect(entry?.cacheWriteTokens).toBe(100)
    expect(entry?.cost).toBeCloseTo(
      0.7 * 0.01 + 0.1 * 0.02 + 0.2 * 0.001 + 0.1 * 0.005,
      10,
    )
  })

  test("missing usage falls back to the local estimate", () => {
    recordStreamingUsage(
      fakeContext("test-model"),
      "acc-1",
      undefined,
      undefined,
      500,
    )
    expect(rowCount()).toBe(1)
    const entry = modelEntry()
    expect(entry?.promptTokens).toBe(500)
    expect(entry?.completionTokens).toBe(0)
  })

  test("missing usage without estimate writes nothing", () => {
    recordStreamingUsage(fakeContext("test-model"), "acc-1", undefined)
    expect(rowCount()).toBe(0)
  })
})

describe("recordDirectStreamingUsage (Anthropic shape)", () => {
  beforeEach(() => {
    statsStore.clearUsageStatsForTest()
    statsStore.setModelPricing("test-model", {
      promptPricePer1k: 0.01,
      completionPricePer1k: 0.02,
      cacheReadPricePer1k: 0.001,
      cacheWritePricePer1k: 0.005,
    })
  })

  test("missing usage falls back to the local estimate", () => {
    recordDirectStreamingUsage(
      fakeContext("test-model"),
      "acc-1",
      undefined,
      undefined,
      600,
    )
    expect(rowCount()).toBe(1)
    const entry = modelEntry()
    expect(entry?.promptTokens).toBe(600)
    expect(entry?.completionTokens).toBe(0)
  })

  test("missing usage without estimate writes nothing", () => {
    recordDirectStreamingUsage(fakeContext("test-model"), "acc-1", undefined)
    expect(rowCount()).toBe(0)
  })
})

describe("updateLastUsage", () => {
  test("merges real input_tokens from final message_delta (Volcengine Ark glm-5.2)", () => {
    // Real upstream shape observed against ark.cn-beijing.volces.com:
    // message_start.usage.input_tokens is stubbed to 0; the final
    // message_delta carries the real input + output counts.
    let last = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: {
          type: "message",
          id: "msg_probe",
          role: "assistant",
          content: [],
          model: "glm-5.2",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      undefined,
    )

    expect(last).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: undefined,
    })

    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: {
          input_tokens: 25,
          output_tokens: 64,
          cache_read_input_tokens: 0,
        },
      }),
      last,
    )

    expect(last).toEqual({
      input_tokens: 25,
      output_tokens: 64,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: undefined,
    })
  })

  test("keeps Anthropic-style message_start input when message_delta only has output", () => {
    let last = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 120,
            output_tokens: 0,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
          },
        },
      }),
      undefined,
    )

    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 18 },
      }),
      last,
    )

    expect(last).toEqual({
      input_tokens: 120,
      output_tokens: 18,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    })
  })

  test("does not let a later zero overwrite a known positive input count", () => {
    let last = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 99, output_tokens: 0 } },
      }),
      undefined,
    )

    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { input_tokens: 0, output_tokens: 7 },
      }),
      last,
    )

    expect(last?.input_tokens).toBe(99)
    expect(last?.output_tokens).toBe(7)
  })
})
