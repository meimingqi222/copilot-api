import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ModelsDevCatalog } from "~/lib/models-dev"

import {
  buildModelsDevPriceIndexes,
  setModelsDevCatalogForTest,
  stopModelsDevPricingForTest,
} from "~/lib/models-dev"
import {
  calculateModelCost,
  promptTotalForTier,
  selectEffectivePricing,
} from "~/lib/models-dev/tier"
import { statsStore } from "~/lib/stats-store"

const TIER_CATALOG: ModelsDevCatalog = {
  google: {
    id: "google",
    name: "Google",
    models: {
      "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        cost: {
          input: 1.25,
          output: 10,
          cache_read: 0.125,
          tiers: [
            {
              input: 2.5,
              output: 15,
              cache_read: 0.25,
              tier: { type: "context", size: 200_000 },
            },
          ],
        },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.5": {
        id: "gpt-5.5",
        cost: {
          input: 5,
          output: 30,
          cache_read: 0.5,
          tiers: [
            {
              input: 10,
              output: 45,
              cache_read: 1,
              tier: { type: "context", size: 272_000 },
            },
          ],
        },
      },
    },
  },
  legacy: {
    id: "legacy",
    name: "Legacy",
    models: {
      "old-model": {
        id: "old-model",
        cost: {
          input: 3,
          output: 15,
          context_over_200k: { input: 6, output: 22.5 },
        },
      },
    },
  },
}

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  setModelsDevCatalogForTest(TIER_CATALOG)
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  stopModelsDevPricingForTest()
  setModelsDevCatalogForTest(null)
})

function mustGet<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key)
  if (value === undefined) throw new Error(`missing pricing for ${String(key)}`)
  return value
}

describe("models.dev context-tier parsing", () => {
  test("parses tiers[] with threshold", () => {
    const idx = buildModelsDevPriceIndexes(TIER_CATALOG)
    const g = idx.byProviderModel.get("google/gemini-2.5-pro")
    expect(g?.contextTierAbove?.thresholdTokens).toBe(200_000)
    expect(g?.contextTierAbove?.promptPricePer1k).toBeCloseTo(0.0025, 10)
    expect(g?.contextTierAbove?.completionPricePer1k).toBeCloseTo(0.015, 10)
    const o = idx.byProviderModel.get("openai/gpt-5.5")
    expect(o?.contextTierAbove?.thresholdTokens).toBe(272_000)
  })

  test("falls back to legacy context_over_200k at 200k", () => {
    const idx = buildModelsDevPriceIndexes(TIER_CATALOG)
    const m = idx.byProviderModel.get("legacy/old-model")
    expect(m?.contextTierAbove?.thresholdTokens).toBe(200_000)
    expect(m?.contextTierAbove?.promptPricePer1k).toBeCloseTo(0.006, 10)
  })
})

describe("tiered cost math (whole-request repricing)", () => {
  test("gemini short vs long", () => {
    const idx = buildModelsDevPriceIndexes(TIER_CATALOG)
    const g = mustGet(idx.byProviderModel, "google/gemini-2.5-pro")
    // 短单：100 * 0.00125 + 1 * 0.01
    expect(
      calculateModelCost(g, { promptTokens: 100_000, completionTokens: 1000 }),
    ).toBeCloseTo(0.135, 10)
    // 长单整单跳价：300 * 0.0025 + 1 * 0.015
    expect(
      calculateModelCost(g, { promptTokens: 300_000, completionTokens: 1000 }),
    ).toBeCloseTo(0.765, 10)
  })

  test("boundary is strict greater-than", () => {
    const idx = buildModelsDevPriceIndexes(TIER_CATALOG)
    const g = mustGet(idx.byProviderModel, "google/gemini-2.5-pro")
    expect(selectEffectivePricing(g, 200_000).tiered).toBe(false)
    expect(selectEffectivePricing(g, 200_001).tiered).toBe(true)
  })

  test("cache tokens count toward the prompt total", () => {
    const idx = buildModelsDevPriceIndexes(TIER_CATALOG)
    const g = mustGet(idx.byProviderModel, "google/gemini-2.5-pro")
    // 190k 普通 + 20k 缓存读 = 210k > 200k，应触发阶梯
    expect(promptTotalForTier(190_000, 20_000, 0)).toBe(210_000)
    expect(
      calculateModelCost(g, {
        promptTokens: 190_000,
        completionTokens: 1000,
        cacheReadTokens: 20_000,
      }),
    ).toBeCloseTo(190 * 0.0025 + 1 * 0.015 + 20 * 0.00025, 10)
  })

  test("gpt-5.5 272k tier", () => {
    const idx = buildModelsDevPriceIndexes(TIER_CATALOG)
    const o = mustGet(idx.byProviderModel, "openai/gpt-5.5")
    expect(
      calculateModelCost(o, {
        promptTokens: 250_000,
        completionTokens: 10_000,
      }),
    ).toBeCloseTo(1.55, 10)
    expect(
      calculateModelCost(o, {
        promptTokens: 280_000,
        completionTokens: 10_000,
      }),
    ).toBeCloseTo(3.25, 10)
  })
})

describe("manual tier pricing roundtrip", () => {
  test("set/get preserves the tier and prices the long request", () => {
    statsStore.setModelPricing("test/tier-model", {
      promptPricePer1k: 0.001,
      completionPricePer1k: 0.01,
      cacheReadPricePer1k: 0.0001,
      cacheWritePricePer1k: 0.001,
      contextThresholdTokens: 200_000,
      extendedPromptPricePer1k: 0.002,
      extendedCompletionPricePer1k: 0.015,
      extendedCacheReadPricePer1k: 0.0002,
      extendedCacheWritePricePer1k: 0.002,
    })
    const resolved = statsStore.resolveModelPricing("test/tier-model")
    expect(resolved?.source).toBe("manual")
    expect(resolved?.contextTierAbove?.thresholdTokens).toBe(200_000)
    const pricing = statsStore.getModelPricing("test/tier-model")
    if (pricing === null) throw new Error("missing manual pricing")
    expect(
      calculateModelCost(pricing, {
        promptTokens: 300_000,
        completionTokens: 1000,
      }),
    ).toBeCloseTo(300 * 0.002 + 1 * 0.015, 10)
    expect(
      calculateModelCost(pricing, {
        promptTokens: 100_000,
        completionTokens: 1000,
      }),
    ).toBeCloseTo(100 * 0.001 + 1 * 0.01, 10)
  })

  test("partial extended prices fall back to base per leg", () => {
    statsStore.setModelPricing("test/partial-tier-model", {
      promptPricePer1k: 0.003,
      completionPricePer1k: 0.015,
      cacheReadPricePer1k: 0.0003,
      cacheWritePricePer1k: 0.003,
      contextThresholdTokens: 200_000,
      extendedPromptPricePer1k: 0.006,
    })
    const resolved = statsStore.resolveModelPricing("test/partial-tier-model")
    expect(resolved?.source).toBe("manual")
    // 未填写的高档价回退基础价，而非 0。
    expect(resolved?.contextTierAbove?.promptPricePer1k).toBeCloseTo(0.006, 10)
    expect(resolved?.contextTierAbove?.completionPricePer1k).toBeCloseTo(
      0.015,
      10,
    )
    expect(resolved?.contextTierAbove?.cacheReadPricePer1k).toBeCloseTo(
      0.0003,
      10,
    )
    const pricing = statsStore.getModelPricing("test/partial-tier-model")
    if (pricing === null) throw new Error("missing manual pricing")
    expect(
      calculateModelCost(pricing, {
        promptTokens: 300_000,
        completionTokens: 1000,
      }),
    ).toBeCloseTo(300 * 0.006 + 1 * 0.015, 10)
  })

  test("all-zero extended prices are ignored (falls back to base)", () => {
    statsStore.setModelPricing("test/zero-tier-model", {
      promptPricePer1k: 0.003,
      completionPricePer1k: 0.015,
      contextThresholdTokens: 200_000,
      extendedPromptPricePer1k: 0,
      extendedCompletionPricePer1k: 0,
      extendedCacheReadPricePer1k: 0,
      extendedCacheWritePricePer1k: 0,
    })
    const resolved = statsStore.resolveModelPricing("test/zero-tier-model")
    expect(resolved?.source).toBe("manual")
    expect(resolved?.contextTierAbove).toBeNull()
    const pricing = statsStore.getModelPricing("test/zero-tier-model")
    if (pricing === null) throw new Error("missing manual pricing")
    expect(
      calculateModelCost(pricing, {
        promptTokens: 300_000,
        completionTokens: 1000,
      }),
    ).toBeCloseTo(300 * 0.003 + 1 * 0.015, 10)
  })
})
