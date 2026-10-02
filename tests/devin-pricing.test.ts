import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, utimesSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runInNewContext } from "node:vm"

import {
  refreshDevinPricing,
  resetDevinPricingForTest,
  resolveDevinPrice,
} from "~/lib/devin-pricing"
import { buildDevinPrices, parseDevinPrices } from "~/lib/devin-pricing/parser"
import { statsStore } from "~/lib/stats-store"

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  resetDevinPricingForTest()
})

function document(
  input = 0,
  tier = "TEAMS_TIER_PRO",
  id = "swe-2-high",
): string {
  return `export const modelCostData = ${JSON.stringify([
    {
      tier,
      model_uid: id,
      input_cost_per_million_usd: input,
      output_cost_per_million_usd: input * 5,
      cache_read_cost_per_million_usd: input / 10,
      cache_write_cost_per_million_usd: 0,
    },
  ])};\nexport const Component = () => null;`
}

describe("SWE official pricing", () => {
  test("resolves SWE Fast without applying a generic fast multiplier", () => {
    const price = statsStore.resolveModelPricing("windsurf/swe-1-6-fast")
    expect(price?.source).toBe("devin-official")
    expect(price?.promptPricePer1k).toBe(0.0005)
    expect(price?.completionPricePer1k).toBe(0.0025)
    expect(price?.cacheReadPricePer1k).toBe(0.0002)
  })

  test("matches bare, prefixed and dotted SWE ids while preserving distinct SKUs", () => {
    expect(resolveDevinPrice("swe-1.6-fast")).toEqual(
      resolveDevinPrice("windsurf/swe-1-6-fast"),
    )
    expect(
      resolveDevinPrice("custom-prefix/swe-1-7-lightning")?.promptPricePer1k,
    ).toBe(0.0025)
    expect(resolveDevinPrice("swe-1-7-fast")).toBeNull()
    expect(resolveDevinPrice("swe-unknown")).toBeNull()
    expect(resolveDevinPrice("claude-opus-4-8")).toBeNull()
  })

  test("preserves promotional zeros and expires stale SWE-2 free prices", () => {
    for (const id of ["swe-2", "swe-2-high", "swe-2-medium", "swe-2-max"]) {
      expect(
        resolveDevinPrice(id, Date.parse("2026-10-15T23:59:59Z"))
          ?.promptPricePer1k,
      ).toBe(0)
      const after = resolveDevinPrice(id, Date.parse("2026-10-16T00:00:00Z"))
      expect(after?.promptPricePer1k).toBe(0.003)
      expect(after?.completionPricePer1k).toBe(0.015)
      expect(after?.cacheReadPricePer1k).toBe(0.0003)
    }
  })

  test("manual overrides still win and deleting them restores the official default", () => {
    statsStore.setModelPricing("swe-1-6-fast", {
      promptPricePer1k: 0.1,
      completionPricePer1k: 0.2,
    })
    expect(statsStore.resolveModelPricing("swe-1-6-fast")?.source).toBe(
      "manual",
    )
    statsStore.deleteModelPricing("swe-1-6-fast")
    expect(statsStore.resolveModelPricing("swe-1-6-fast")?.source).toBe(
      "devin-official",
    )
  })

  test("parser reads only Pro rates, rejects malformed prices and retains known free rates", () => {
    expect(
      parseDevinPrices(document()).get("swe-2-high")?.promptPricePer1k,
    ).toBe(0)
    expect(() =>
      parseDevinPrices(document(0.75, "TEAMS_TIER_ENTERPRISE_SAAS")),
    ).toThrow()
    expect(() => parseDevinPrices(document(-1))).toThrow()
    expect(() => parseDevinPrices(document(1, "TEAMS_TIER_PRO", ""))).toThrow()
    expect(() => parseDevinPrices("export const modelCostData = [];")).toThrow()
    const pro = {
      tier: "TEAMS_TIER_PRO",
      model_uid: "swe-2-high",
      input_cost_per_million_usd: 0,
      output_cost_per_million_usd: 0,
      cache_read_cost_per_million_usd: 0,
      cache_write_cost_per_million_usd: 0,
    }
    const enterprise = {
      ...pro,
      tier: "TEAMS_TIER_ENTERPRISE_SAAS",
      input_cost_per_million_usd: 0.75,
    }
    expect(
      buildDevinPrices([enterprise, pro]).get("swe-2-high")?.promptPricePer1k,
    ).toBe(0)
    expect(() => buildDevinPrices([pro, pro])).toThrow()
    expect(() =>
      buildDevinPrices([{ ...pro, input_cost_per_million_usd: Infinity }]),
    ).toThrow()
  })

  test("refresh caches valid prices, preserves last good data on failure and backs off", async () => {
    const filePath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "devin-pricing-")),
      "models.md",
    )
    const now = Date.now()
    let calls = 0
    const fetchDocument = async () => {
      calls++
      return document(4)
    }
    await refreshDevinPricing({ filePath, now, fetchDocument })
    expect(resolveDevinPrice("swe-2-high", now)?.promptPricePer1k).toBe(0.004)
    expect(readFileSync(filePath, "utf8")).toBe(document(4))
    await refreshDevinPricing({ filePath, now, fetchDocument })
    expect(calls).toBe(1)
    resetDevinPricingForTest()
    await refreshDevinPricing({ filePath, now, fetchDocument })
    expect(resolveDevinPrice("swe-2-high", now)?.promptPricePer1k).toBe(0.004)
    expect(calls).toBe(1)
    const old = new Date(now - 25 * 60 * 60 * 1000)
    utimesSync(filePath, old, old)
    await refreshDevinPricing({
      filePath,
      now,
      fetchDocument: async () => "bad MDX",
    })
    expect(resolveDevinPrice("swe-2-high", now)?.promptPricePer1k).toBe(0.004)
    expect(readFileSync(filePath, "utf8")).toBe(document(4))
    await refreshDevinPricing({ filePath, now: now + 1000, fetchDocument })
    expect(calls).toBe(1)
    await refreshDevinPricing({
      filePath,
      now: now + 60 * 60 * 1000,
      fetchDocument: async () => document(),
    })
    expect(resolveDevinPrice("swe-2-high", now)?.promptPricePer1k).toBe(0)
  })

  test("the admin view includes Devin prices in official counts and filtering", () => {
    const v = runInNewContext(
      readFileSync("pages/js/views/usage.js", "utf8") + "\nusageView()",
      { ViewHelpers: {} },
    )
    v.modelPrices = { "swe-2-high": {}, unknown: {} }
    v.t = (key: string) => key
    v.pricingSources = { "swe-2-high": "devin-official", unknown: "unmatched" }
    expect(v.isPricingOfficial("swe-2-high")).toBe(true)
    expect(v.pricingCounts.official).toBe(1)
    v.pricingFilter = "official"
    expect(Array.from(v.filteredModelKeys)).toEqual(["swe-2-high"])
    expect(v.pricingProviderTabs[0].count).toBe(1)
    v.pricingFilter = "unmatched"
    expect(Array.from(v.filteredModelKeys)).toEqual(["unknown"])
  })
})
