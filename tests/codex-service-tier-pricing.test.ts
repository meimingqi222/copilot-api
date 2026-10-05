import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { initRequestLog, patchRequestLog } from "~/lib/request-log"
import {
  observeResponseServiceTier,
  observeServiceTierStream,
  recordSentServiceTier,
} from "~/lib/service-tier-trace"
import { statsStore } from "~/lib/stats-store"
import { recordUsage } from "~/lib/usage"

const model = "codex-tier-pricing-test"

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  statsStore.setModelPricing(model, {
    promptPricePer1k: 0.01,
    completionPricePer1k: 0.02,
    cacheReadPricePer1k: 0.001,
    cacheWritePricePer1k: 0.005,
    contextThresholdTokens: 5000,
    extendedPromptPricePer1k: 0.02,
    extendedCompletionPricePer1k: 0.03,
    extendedCacheReadPricePer1k: 0.002,
    extendedCacheWritePricePer1k: 0.006,
  })
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  statsStore.deleteModelPricing(model)
})

async function cost(options: {
  sent?: string
  response?: string
  provider?: string
  traceOwner?: string
  streaming?: boolean
  promptTokens?: number
  requested?: string
}) {
  const app = new Hono().get("/", async (c) => {
    initRequestLog(c)
    patchRequestLog(c, {
      connectionId: options.traceOwner ?? "tier-account",
      serviceTierRequested: options.requested,
    })
    recordSentServiceTier(c, options.sent)
    const response = { service_tier: options.response }
    if (options.streaming) {
      async function* events() {
        yield {
          data: JSON.stringify({ type: "response.completed", response }),
        }
      }
      for await (const event of observeServiceTierStream(events(), c)) {
        void event
      }
    } else {
      observeResponseServiceTier(c, response)
    }
    recordUsage({
      c,
      accountId: "tier-account",
      provider: options.provider ?? "codex",
      model,
      promptTokens: options.promptTokens ?? 1000,
      completionTokens: 1000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 1000,
      totalTokens: (options.promptTokens ?? 1000) + 3000,
      streaming: options.streaming,
    })
    return c.text("OK")
  })
  await app.request("/")
  const date = statsStore.getDateString()
  return statsStore.getUsageStats("tier-account", date, date)[0]?.models[model]
    ?.cost
}

describe("Codex service-tier accounting", () => {
  for (const streaming of [false, true]) {
    for (const response of ["fast", "priority"]) {
      test(`${response} costs 2x including cache in streaming=${streaming}`, async () => {
        expect(await cost({ response, streaming })).toBeCloseTo(0.072)
      })
    }
    test(`upstream default overrides sent priority in streaming=${streaming}`, async () => {
      expect(
        await cost({ sent: "priority", response: "default", streaming }),
      ).toBeCloseTo(0.036)
    })
  }

  test("missing response tier falls back to the actual sent tier", async () => {
    expect(await cost({ sent: "priority" })).toBeCloseTo(0.072)
  })

  test("requested Fast alone does not prove it was sent", async () => {
    expect(await cost({ requested: "fast" })).toBeCloseTo(0.036)
  })

  test("another provider after failover does not inherit the Codex surcharge", async () => {
    expect(
      await cost({ provider: "copilot", sent: "priority", response: "fast" }),
    ).toBeCloseTo(0.036)
  })

  test("a different connection's tier cannot affect the usage owner", async () => {
    expect(
      await cost({ traceOwner: "failed-account", response: "priority" }),
    ).toBeCloseTo(0.036)
  })

  test("Fast multiplier applies after long-context pricing", async () => {
    expect(
      await cost({ response: "priority", promptTokens: 4000 }),
    ).toBeCloseTo(0.236)
  })

  for (const response of ["default", "auto", "flex", "scale"]) {
    test(`${response} keeps the base monetary rate`, async () => {
      expect(await cost({ response })).toBeCloseTo(0.036)
    })
  }

  test("explicit free manual pricing stays free in Fast mode", async () => {
    statsStore.setModelPricing(model, {
      promptPricePer1k: 0,
      completionPricePer1k: 0,
    })
    expect(await cost({ response: "priority" })).toBe(0)
  })
})
