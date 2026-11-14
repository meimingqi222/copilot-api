import type { Context } from "hono"

import { beforeEach, describe, expect, test } from "bun:test"

import { statsStore } from "~/lib/stats-store"
import { recordUsage } from "~/lib/usage"
import {
  recordDirectStreamingUsage,
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

test("Trae's 0/0 cache answer is recorded as uncounted; another provider's is not", () => {
  statsStore.clearUsageStatsForTest()
  const now = Date.now()
  const c = fakeContext("glm-5.2")
  recordUsage({
    c,
    accountId: "trae-acc",
    provider: "trae-cn",
    model: "glm-5.2",
    promptTokens: 1000,
    completionTokens: 100,
    totalTokens: 1100,
    timestamp: now,
  })
  recordUsage({
    c,
    accountId: "copilot-acc",
    provider: "copilot",
    model: "gpt-5",
    promptTokens: 500,
    completionTokens: 50,
    totalTokens: 550,
    timestamp: now + 1,
  })

  const byProvider = statsStore.getUsageStatsByProviderInRange({
    startMs: now - 60_000,
    endMs: now + 60_000,
  })
  expect(byProvider["trae-cn"]?.cacheUnknownPromptTokens).toBe(1000)
  expect(byProvider["copilot"]?.cacheUnknownPromptTokens).toBe(0)
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

  test("missing usage without estimate preserves one zero-token request", () => {
    recordDirectStreamingUsage(fakeContext("test-model"), "acc-1", undefined)
    expect(rowCount()).toBe(1)
    expect(modelEntry()?.requests).toBe(1)
    expect(modelEntry()?.cost).toBe(0)
  })

  test("pending terminal usage replaces the message-start estimate without charging it", () => {
    const initial = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 600, output_tokens: 0 } },
      }),
      undefined,
    )
    const final = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          usage_status: "pending",
          context_window: { used_tokens: 12000, max_tokens: 128000 },
        },
      }),
      initial,
    )
    recordDirectStreamingUsage(
      fakeContext("test-model"),
      "acc-1",
      final,
      undefined,
      600,
    )
    expect(modelEntry()).toMatchObject({
      requests: 1,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    })
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
