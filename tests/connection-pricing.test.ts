import type { Context } from "hono"
import { statsStore } from "~/lib/stats-store"
import {
  recordDirectStreamingUsage,
  updateLastUsage,
} from "~/routes/messages/usage-recorder"
import { recordResponsesUsage } from "~/routes/responses/handler"
import { historicalCostEstimate } from "~/lib/stats/historical-pricing"
import { afterEach, expect, test } from "bun:test"
import {
  connectionPricingProvider,
  resolveConnectionModelPricing,
} from "~/lib/connection-pricing"
import { setModelsDevCatalogForTest } from "~/lib/models-dev"
import { calculateModelCost } from "~/lib/models-dev/tier"
import type { ProviderConnection } from "~/lib/provider-connections"
import {
  decodeMessagesResponse,
  encodeChatResponse,
  decodeChatResponse,
} from "~/services/ir/codecs/messages-chat"

const connection: ProviderConnection = {
  id: "reseller",
  name: "reseller",
  protocol: "openai-compatible",
  baseUrl: "https://reseller.test/v1",
  enabled: true,
  priority: 1,
  createdAt: 0,
  credentials: [],
  models: [
    {
      publicId: "my-model",
      upstreamId: "anthropic/claude-test",
      endpoints: ["chat"],
      enabled: true,
    },
  ],
}
afterEach(() => setModelsDevCatalogForTest(null))

test("compatible connection prices the actual model through its endpoint channel", () => {
  setModelsDevCatalogForTest({
    reseller: {
      id: "reseller",
      api: "https://reseller.test/v1",
      models: {
        "anthropic/claude-test": {
          id: "anthropic/claude-test",
          cost: { input: 9, output: 18 },
        },
      },
    },
    anthropic: {
      id: "anthropic",
      models: {
        "claude-test": { id: "claude-test", cost: { input: 2, output: 10 } },
      },
    },
  })
  expect(connectionPricingProvider(connection)).toBe("reseller")
  expect(
    resolveConnectionModelPricing(connection, "my-model")?.promptPricePer1k,
  ).toBe(0.009)
  expect(
    resolveConnectionModelPricing(
      { ...connection, baseUrl: "https://unknown.test" },
      "my-model",
    ),
  ).toBeNull()
})

test("one-hour cache writes retain their TTL through messages and chat codecs", () => {
  const ir = decodeMessagesResponse({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 100,
      cache_creation: {
        ephemeral_5m_input_tokens: 40,
        ephemeral_1h_input_tokens: 60,
      },
    },
  })
  expect(ir.usage?.cacheWrite1hTokens).toBe(60)
  const translated = decodeChatResponse(encodeChatResponse(ir))
  expect(translated.usage?.cacheWrite1hTokens).toBe(60)
})

test("one-hour writes use twice the effective input price, including context tiers", () => {
  const pricing = {
    promptPricePer1k: 0.003,
    completionPricePer1k: 0.015,
    cacheReadPricePer1k: 0.0003,
    cacheWritePricePer1k: 0.00375,
    contextTierAbove: {
      thresholdTokens: 100,
      promptPricePer1k: 0.006,
      completionPricePer1k: 0.03,
      cacheReadPricePer1k: 0.0006,
      cacheWritePricePer1k: 0.0075,
    },
  }
  expect(
    calculateModelCost(pricing, {
      promptTokens: 10,
      completionTokens: 20,
      cacheWriteTokens: 100,
      cacheWrite1hTokens: 60,
    }),
  ).toBeCloseTo(0.00168, 10)
})

test("streaming TTL merges and Responses cache writes reach persisted costs", () => {
  statsStore.clearUsageStatsForTest()
  statsStore.setModelPricing("ttl-test", {
    promptPricePer1k: 0.003,
    completionPricePer1k: 0.015,
    cacheReadPricePer1k: 0.0003,
    cacheWritePricePer1k: 0.00375,
  })
  const c = {
    get: (key: string) => (key === "model" ? "ttl-test" : undefined),
  } as unknown as Context
  const initial = updateLastUsage(
    JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation_input_tokens: 100,
          cache_creation: {
            ephemeral_5m_input_tokens: 40,
            ephemeral_1h_input_tokens: 60,
          },
        },
      },
    }),
    undefined,
  )
  const final = updateLastUsage(
    JSON.stringify({ type: "message_delta", usage: { output_tokens: 20 } }),
    initial,
  )
  expect(final?.cache_creation?.ephemeral_1h_input_tokens).toBe(60)
  recordDirectStreamingUsage(c, "ttl-owner", final)
  const date = statsStore.getDateString()
  expect(
    statsStore.getUsageStats("ttl-owner", date, date)[0]?.models["ttl-test"]
      .cost,
  ).toBeCloseTo(0.00084, 10)
  recordResponsesUsage({
    c,
    accountId: "responses-owner",
    streaming: false,
    response: {
      id: "r",
      status: "completed",
      object: "response",
      model: "ttl-test",
      output: [],
      usage: {
        input_tokens: 110,
        output_tokens: 20,
        total_tokens: 130,
        input_tokens_details: {
          cache_creation_input_tokens: 100,
          cache_creation: {
            ephemeral_5m_input_tokens: 40,
            ephemeral_1h_input_tokens: 60,
          },
        },
      },
    },
  })
  const row = statsStore.getUsageStats("responses-owner", date, date)[0]
    ?.models["ttl-test"]
  expect(row?.promptTokens).toBe(10)
  expect(row?.cacheWriteTokens).toBe(100)
  expect(row?.cost).toBeCloseTo(0.00084, 10)
  statsStore.clearUsageStatsForTest()
})

test("historical repricing skips insufficient metadata instead of erasing costs", () => {
  const pricing = {
    promptPricePer1k: 0.003,
    completionPricePer1k: 0.015,
    cacheReadPricePer1k: 0.0003,
    cacheWritePricePer1k: 0.00375,
  }
  const row = {
    provider: "claude",
    prompt_tokens: 1000,
    completion_tokens: 100,
    cache_read_tokens: 10,
    cache_write_tokens: 0,
  }
  expect(historicalCostEstimate(null, row)).toBeNull()
  expect(
    historicalCostEstimate(pricing, { ...row, provider: "codex" }),
  ).toBeNull()
  expect(
    historicalCostEstimate(pricing, { ...row, cache_write_tokens: 10 }),
  ).toBeNull()
  expect(
    historicalCostEstimate(
      { ...pricing, contextTierAbove: { ...pricing, thresholdTokens: 100 } },
      row,
    ),
  ).toBeNull()
  expect(historicalCostEstimate(pricing, row)).toBeCloseTo(0.004503, 10)
})
