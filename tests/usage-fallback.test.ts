/**
 * 无上游 usage 时的估算兜底:chat 流式与 responses。
 * messages 两条路径见 tests/usage-recorder.test.ts。
 */

import type { Context } from "hono"

import { beforeEach, describe, expect, test } from "bun:test"

import { statsStore } from "~/lib/stats-store"
import { recordStreamingUsage } from "~/routes/chat-completions/usage"
import { recordResponsesUsage } from "~/routes/responses/handler"

function fakeContext(model: string, accountId = "acc-1"): Context {
  const store: Record<string, unknown> = { model, accountId }
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

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  statsStore.setModelPricing("test-model", {
    promptPricePer1k: 0.01,
    completionPricePer1k: 0.02,
    cacheReadPricePer1k: 0.001,
    cacheWritePricePer1k: 0.005,
  })
})

describe("chat streaming estimate fallback", () => {
  test("missing usage writes the estimate row", () => {
    const ok = recordStreamingUsage({
      c: fakeContext("test-model"),
      accountId: "acc-1",
      model: "test-model",
      lastUsage: undefined,
      estimatedInputTokens: 400,
    })
    expect(ok).toBe(true)
    expect(rowCount()).toBe(1)
    const entry = modelEntry()
    expect(entry?.promptTokens).toBe(400)
    expect(entry?.completionTokens).toBe(0)
  })

  test("missing identity writes nothing", () => {
    const ok = recordStreamingUsage({
      c: fakeContext("test-model"),
      accountId: undefined,
      model: "test-model",
      lastUsage: undefined,
      estimatedInputTokens: 400,
    })
    expect(ok).toBe(false)
    expect(rowCount()).toBe(0)
  })
})

describe("responses zero-row fallback", () => {
  test("missing usage keeps the request count with zero cost", () => {
    recordResponsesUsage({
      c: fakeContext("test-model"),
      accountId: "acc-1",
      response: { status: "completed" } as never,
      streaming: false,
    })
    expect(rowCount()).toBe(1)
    const entry = modelEntry()
    expect(entry?.promptTokens).toBe(0)
    expect(entry?.completionTokens).toBe(0)
    expect(entry?.cost).toBe(0)
    expect(entry?.requests).toBe(1)
  })
})
