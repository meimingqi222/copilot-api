import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ModelsDevCatalog } from "~/lib/models-dev"

import {
  buildPricingLookupCandidates,
  resolveModelsDevPrice,
  resolveModelsDevPriceDetailed,
  setModelsDevCatalogForTest,
  stopModelsDevPricingForTest,
} from "~/lib/models-dev"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const TEST_CATALOG: ModelsDevCatalog = {
  xiaomi: {
    id: "xiaomi",
    name: "Xiaomi",
    models: {
      "mimo-v2.5-pro": {
        id: "mimo-v2.5-pro",
        cost: { input: 1, output: 3, cache_read: 0.2 },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4.7": {
        id: "claude-opus-4.7",
        cost: { input: 5, output: 25, cache_read: 0.5 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.1-codex": {
        id: "gpt-5.1-codex",
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    models: {
      "gemini-3-flash-preview": {
        id: "gemini-3-flash-preview",
        cost: { input: 0.5, output: 3, cache_read: 0.05 },
      },
    },
  },
  "github-copilot": {
    id: "github-copilot",
    name: "GitHub Copilot",
    models: {
      "claude-sonnet-4.6": {
        id: "claude-sonnet-4.6",
        cost: { input: 3, output: 15, cache_read: 0.3 },
      },
    },
  },
}

const originalModels = state.models

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  setModelsDevCatalogForTest(TEST_CATALOG)
  state.models = {
    object: "list",
    data: [
      {
        id: "mimo-aistudio/mimo-v2.5-pro",
        object: "model",
        name: "MiMo V2.5 Pro",
        preview: false,
        vendor: "MiMo",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "mimo-aistudio",
          object: "capabilities",
          supports: { streaming: true },
          tokenizer: "unknown",
          type: "chat",
        },
      },
      {
        id: "windsurf/swe-1-6-fast",
        object: "model",
        name: "SWE-1.6 Fast",
        preview: false,
        vendor: "Windsurf",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "windsurf",
          object: "capabilities",
          supports: { streaming: true },
          tokenizer: "unknown",
          type: "chat",
        },
      },
    ],
  }
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  stopModelsDevPricingForTest()
  setModelsDevCatalogForTest(null)
  state.models = originalModels
})

describe("models.dev pricing resolver", () => {
  test("maps mimo-aistudio models through xiaomi provider bucket", () => {
    const resolved = resolveModelsDevPriceDetailed(
      "mimo-aistudio/mimo-v2.5-pro",
    )
    expect(resolved?.source).toBe("models-dev")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.001, 10)
    expect(resolved?.completionPricePer1k).toBeCloseTo(0.003, 10)
  })

  test("maps copilot models through github-copilot bucket", () => {
    const resolved = resolveModelsDevPriceDetailed("copilot/claude-sonnet-4.6")
    expect(resolved?.source).toBe("models-dev")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.003, 10)
  })

  test("normalizes windsurf tiered openai models", () => {
    const resolved = resolveModelsDevPriceDetailed("windsurf/gpt-5.1-codex-low")
    expect(resolved?.source).toBe("models-dev")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.00125, 10)
  })

  test("normalizes windsurf claude dot-dash variants", () => {
    const resolved = resolveModelsDevPriceDetailed(
      "windsurf/claude-opus-4-7-medium",
    )
    expect(resolved?.source).toBe("models-dev")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.005, 10)
  })

  test("normalizes windsurf gemini flash aliases", () => {
    const resolved = resolveModelsDevPriceDetailed(
      "windsurf/gemini-3.0-flash-low",
    )
    expect(resolved?.source).toBe("models-dev")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.0005, 10)
  })

  test("leaves windsurf proprietary swe models unmatched", () => {
    expect(resolveModelsDevPrice("windsurf/swe-1-6-fast")).toBeNull()
    expect(buildPricingLookupCandidates("swe-1-6-fast", "windsurf")).toEqual([])
  })

  test("prefers manual DB pricing over models.dev", () => {
    statsStore.setModelPricing("copilot/claude-sonnet-4.6", {
      promptPricePer1k: 0.99,
      completionPricePer1k: 0.88,
      cacheReadPricePer1k: 0.1,
      cacheWritePricePer1k: 0.2,
    })

    const resolved = statsStore.resolveModelPricing("copilot/claude-sonnet-4.6")
    expect(resolved?.source).toBe("manual")
    expect(resolved?.promptPricePer1k).toBe(0.99)
  })
})

describe("GET /admin/api/usage/pricing", () => {
  test("returns models.dev and unmatched pricing sources", async () => {
    const response = await server.fetch(
      new Request("http://localhost/admin/api/usage/pricing"),
    )
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      pricing: Record<string, { promptPricePer1k: number }>
      sources: Record<string, string>
    }

    expect(body.sources["mimo-aistudio/mimo-v2.5-pro"]).toBe("models-dev")
    expect(body.sources["windsurf/swe-1-6-fast"]).toBe("unmatched")
    expect(
      body.pricing["mimo-aistudio/mimo-v2.5-pro"].promptPricePer1k,
    ).toBeCloseTo(0.001, 10)
    expect(body.pricing["windsurf/swe-1-6-fast"].promptPricePer1k).toBe(0)
  })
})
