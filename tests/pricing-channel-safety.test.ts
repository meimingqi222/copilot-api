import { afterEach, expect, test } from "bun:test"
import {
  buildModelsDevPriceIndexes,
  resolveModelsDevPriceDetailed,
  setModelsDevCatalogForTest,
} from "~/lib/models-dev"
import { lookupProviderModelPrice } from "~/lib/models-dev/catalog"
import { getDefaultModelPrice } from "~/lib/default-prices"
import { statsStore } from "~/lib/stats-store"

afterEach(() => setModelsDevCatalogForTest(null))

test("provider-local full IDs survive conflicting tail aliases", () => {
  const catalog = {
    reseller: {
      id: "reseller",
      models: {
        model: { id: "model", cost: { input: 1, output: 2 } },
        "tee/model": { id: "tee/model", cost: { input: 9, output: 18 } },
        "a/other": { id: "a/other", cost: { input: 3, output: 6 } },
        "b/other": { id: "b/other", cost: { input: 4, output: 8 } },
      },
    },
  }
  const indexes = buildModelsDevPriceIndexes(catalog)
  expect(
    lookupProviderModelPrice(indexes, ["reseller"], "model")?.promptPricePer1k,
  ).toBe(0.001)
  expect(lookupProviderModelPrice(indexes, ["reseller"], "other")).toBeNull()
  setModelsDevCatalogForTest(catalog)
  expect(
    resolveModelsDevPriceDetailed("reseller/tee/model")?.promptPricePer1k,
  ).toBe(0.009)
})

test("explicit channel cannot borrow another channel's quote", () => {
  setModelsDevCatalogForTest({
    anthropic: {
      id: "anthropic",
      models: {
        "claude-test": { id: "claude-test", cost: { input: 2, output: 10 } },
      },
    },
    reseller: { id: "reseller", models: {} },
  })
  expect(resolveModelsDevPriceDetailed("reseller/claude-test")).toBeNull()
  expect(resolveModelsDevPriceDetailed("claude-test", "xai")).toBeNull()
})

test("native commercial variants never borrow a base price", () => {
  setModelsDevCatalogForTest({
    openai: {
      id: "openai",
      models: {
        "gpt-99": { id: "gpt-99", cost: { input: 2, output: 10 } },
      },
    },
  })
  for (const suffix of ["mini", "nano", "max", "fast"]) {
    expect(
      resolveModelsDevPriceDetailed(`gpt-99-${suffix}`, "codex"),
    ).toBeNull()
  }
  expect(getDefaultModelPrice("claude-sonnet-4.6-unknown-pro")).toBeNull()
})

test("missing cache rate falls back to input while explicit zero remains free", () => {
  const idx = buildModelsDevPriceIndexes({
    p: {
      id: "p",
      models: {
        missing: { id: "missing", cost: { input: 2, output: 10 } },
        zero: {
          id: "zero",
          cost: { input: 2, output: 10, cache_read: 0, cache_write: 0 },
        },
      },
    },
  })
  expect(idx.byProviderModel.get("p/missing")?.cacheReadPricePer1k).toBe(0.002)
  expect(idx.byProviderModel.get("p/zero")?.cacheReadPricePer1k).toBe(0)
})

test("Devin product prices do not override explicitly unrelated channels", () => {
  expect(statsStore.resolveModelPricing("codex/swe-1-6", "codex")).toBeNull()
})

test("a connection channel wins over the model author namespace", () => {
  setModelsDevCatalogForTest({
    openrouter: {
      id: "openrouter",
      models: {
        "xai/grok-test": {
          id: "xai/grok-test",
          cost: { input: 7, output: 14 },
        },
      },
    },
    xai: {
      id: "xai",
      models: {
        "grok-test": { id: "grok-test", cost: { input: 2, output: 4 } },
      },
    },
  })
  expect(
    resolveModelsDevPriceDetailed("xai/grok-test", "openrouter")
      ?.promptPricePer1k,
  ).toBe(0.007)
  expect(statsStore.resolveModelPricing("claude-sonnet-4.6", "xai")).toBeNull()
})

test("exact native IDs beat dot-dash aliases and missing literal prices stay unmatched", () => {
  setModelsDevCatalogForTest({
    openai: {
      id: "openai",
      models: {
        "gpt-99-1": { id: "gpt-99-1", cost: { input: 7, output: 14 } },
        "gpt-99.1": { id: "gpt-99.1", cost: { input: 2, output: 4 } },
      },
    },
  })
  expect(
    resolveModelsDevPriceDetailed("gpt-99-1", "codex")?.promptPricePer1k,
  ).toBe(0.007)
  const indexes = buildModelsDevPriceIndexes({
    p: {
      id: "p",
      models: {
        model: { id: "model" },
        "tee/model": { id: "tee/model", cost: { input: 9, output: 18 } },
        invalid: { id: "invalid", cost: { input: -1, output: 3 } },
        free: { id: "free", cost: { input: 0, output: 0 } },
      },
    },
  })
  expect(indexes.byProviderModel.get("p/model")).toBeUndefined()
  expect(indexes.byProviderModel.get("p/invalid")).toBeUndefined()
  expect(indexes.byProviderModel.get("p/free")?.promptPricePer1k).toBe(0)
})
test("offline fallback retains official rates and context thresholds", () => {
  setModelsDevCatalogForTest(null)
  expect(statsStore.getModelPricing("gpt-4.1", "codex")?.promptPricePer1k).toBe(
    0.002,
  )
  expect(
    statsStore.getModelPricing("gpt-6-sol", "codex")?.contextTierAbove
      ?.thresholdTokens,
  ).toBe(272000)
})
