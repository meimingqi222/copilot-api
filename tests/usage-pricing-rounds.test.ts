import type { Context } from "hono"

import { beforeEach, expect, test } from "bun:test"

import { statsStore } from "~/lib/stats-store"
import { recordUsage } from "~/lib/usage"
import {
  clearUsagePricingRounds,
  createUsagePricingRecorder,
} from "~/lib/usage-pricing-rounds"

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  statsStore.setModelPricing("round-pricing-fixture", {
    promptPricePer1k: 0.001,
    completionPricePer1k: 0,
    contextThresholdTokens: 200_000,
    extendedPromptPricePer1k: 0.002,
  })
})

function context(): Context {
  const values = new Map<string, unknown>()
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value)
    },
  } as unknown as Context
}

function write(c: Context, accountId: string): number | undefined {
  recordUsage({
    c,
    accountId,
    model: "round-pricing-fixture",
    promptTokens: 300_000,
    completionTokens: 0,
    totalTokens: 300_000,
  })
  return statsStore.getUsageStats(accountId)[0]?.cost
}

test("round pricing cannot leak across requests or a failover to another account", () => {
  const first = context()
  const second = context()
  const record = createUsagePricingRecorder(first, "pricing-first")
  record({ source: "reported", inputTokens: 150_000 })
  record({ source: "reported", inputTokens: 150_000 })
  expect(write(second, "pricing-second")).toBeCloseTo(0.6, 10)
  expect(write(first, "pricing-failover")).toBeCloseTo(0.6, 10)
})

test("round metadata is consumed once and a fresh attempt clears earlier rounds", () => {
  const c = context()
  const record = createUsagePricingRecorder(c, "pricing-owner")
  record({ source: "reported", inputTokens: 150_000 })
  record({ source: "reported", inputTokens: 150_000 })
  expect(write(c, "pricing-owner")).toBeCloseTo(0.3, 10)
  expect(write(c, "pricing-owner")).toBeCloseTo(0.9, 10)
  const laterAttempt = createUsagePricingRecorder(c, "pricing-owner")
  laterAttempt({ source: "reported", inputTokens: 150_000 })
  clearUsagePricingRounds(c)
  expect(write(c, "pricing-owner")).toBeCloseTo(1.5, 10)
})
