import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/legacy-accounts"
import type { ModelsDevCatalog } from "~/lib/models-dev"

import { listAccounts } from "~/lib/legacy-accounts"
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

import {
  adminRequest,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"
import { setTestAccounts } from "./helpers/set-accounts"

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
      // Fresh, just-discounted price direct from the OpenAI bucket — used to
      // simulate a models.dev provider desync (see "github-copilot" below).
      "gpt-9-mini": {
        id: "gpt-9-mini",
        cost: { input: 0.2, output: 1.2, cache_read: 0.02 },
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
      "claude-opus-4.8": {
        id: "claude-opus-4.8",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      // Stale price — models.dev hasn't synced GitHub Copilot's listing with
      // OpenAI's discount yet, even though the same model is already fresh
      // in the "openai" bucket above.
      "gpt-9-mini": {
        id: "gpt-9-mini",
        cost: { input: 1, output: 6, cache_read: 0.1 },
      },
    },
  },
}

const originalModels = state.models

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  setModelsDevCatalogForTest(TEST_CATALOG)
  clearAdminPasswordConfig()
  setupAdminAuth()
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
  clearAdminAuth()
  clearAdminPasswordConfig()
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

  test("normalizes windsurf claude -max suffix (intensity, no price change)", () => {
    const resolved = resolveModelsDevPriceDetailed(
      "windsurf/claude-opus-4-8-max",
    )
    expect(resolved?.source).toBe("models-dev")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.005, 10)
    expect(resolved?.completionPricePer1k).toBeCloseTo(0.025, 10)
  })

  test("applies 2x fast multiplier for claude-opus-4.8", () => {
    const resolved = resolveModelsDevPriceDetailed(
      "windsurf/claude-opus-4-8-max-fast",
    )
    expect(resolved?.source).toBe("models-dev")
    // base: 5/1000 = 0.005, fast 2x => 0.01
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.01, 10)
    expect(resolved?.completionPricePer1k).toBeCloseTo(0.05, 10)
    expect(resolved?.cacheReadPricePer1k).toBeCloseTo(0.001, 10)
    expect(resolved?.cacheWritePricePer1k).toBeCloseTo(0.0125, 10)
  })

  test("applies 6x fast multiplier for older claude-opus-4.7", () => {
    const resolved = resolveModelsDevPriceDetailed(
      "windsurf/claude-opus-4-7-fast",
    )
    expect(resolved?.source).toBe("models-dev")
    // base: 5/1000 = 0.005, fast 6x => 0.03
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.03, 10)
    expect(resolved?.completionPricePer1k).toBeCloseTo(0.15, 10)
  })

  test("applies 2x fast multiplier for openai models", () => {
    const resolved = resolveModelsDevPriceDetailed(
      "windsurf/gpt-5.1-codex-low-fast",
    )
    expect(resolved?.source).toBe("models-dev")
    // base: 1.25/1000 = 0.00125, fast 2x => 0.0025
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.0025, 10)
    expect(resolved?.completionPricePer1k).toBeCloseTo(0.02, 10)
  })

  test("matches bare claude-opus-4-8-max-fast with provider hint", () => {
    const resolved = resolveModelsDevPriceDetailed(
      "claude-opus-4-8-max-fast",
      "windsurf",
    )
    expect(resolved?.source).toBe("models-dev")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.01, 10)
    expect(resolved?.completionPricePer1k).toBeCloseTo(0.05, 10)
  })

  test("matches bare claude-opus-4-8-max-fast without provider hint (inferred windsurf)", () => {
    const resolved = resolveModelsDevPriceDetailed("claude-opus-4-8-max-fast")
    expect(resolved?.source).toBe("models-dev")
    // Inferred as windsurf-like because vendor bucket is non-empty
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.01, 10)
    expect(resolved?.completionPricePer1k).toBeCloseTo(0.05, 10)
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

  test("falls back to builtin prices when models.dev has no match", () => {
    stopModelsDevPricingForTest()
    const resolved = statsStore.resolveModelPricing("claude-sonnet-4.6")
    expect(resolved?.source).toBe("builtin")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.003, 10)
    expect(resolved?.completionPricePer1k).toBeCloseTo(0.015, 10)
  })

  test("without a provider hint, a stale bucket earlier in global priority wins", () => {
    // github-copilot ranks ahead of openai in GLOBAL_MODEL_PROVIDER_PRIORITY,
    // so the provider-agnostic global lookup picks up its stale price even
    // though openai's own listing has already been discounted.
    const resolved = resolveModelsDevPriceDetailed("gpt-9-mini")
    expect(resolved?.source).toBe("models-dev")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.001, 10)
  })

  test("a correct provider hint resolves through the fresh bucket instead", () => {
    // codex's provider priority is ["openai", "github-copilot"], so passing
    // the hint should avoid the stale github-copilot price above.
    const resolved = resolveModelsDevPriceDetailed("gpt-9-mini", "codex")
    expect(resolved?.source).toBe("models-dev")
    expect(resolved?.promptPricePer1k).toBeCloseTo(0.0002, 10)
  })

  test("statsStore.getModelPricing threads the provider hint through to resolution", () => {
    expect(
      statsStore.getModelPricing("gpt-9-mini")?.promptPricePer1k,
    ).toBeCloseTo(0.001, 10)
    expect(
      statsStore.getModelPricing("gpt-9-mini", "codex")?.promptPricePer1k,
    ).toBeCloseTo(0.0002, 10)
  })
})

function codexAccount(overrides?: Partial<Account>): Account {
  return {
    id: "codex-1",
    label: "codex",
    provider: "codex",
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
    credentials: {},
    settings: {},
    availableModels: [
      {
        id: "gpt-9-mini",
        name: "GPT-9 Mini",
        vendor: "openai",
        pickerEnabled: true,
        supportedEndpoints: ["/v1/responses"],
        provider: "codex",
        upstreamId: "gpt-9-mini",
      },
    ],
    ...overrides,
  } as Account
}

describe("pricing provider-hint desync regression", () => {
  test("GET /admin/api/usage/pricing uses the account's provider bucket, not the stale global one", async () => {
    const originalAccounts = listAccounts()
    const originalModelsData = state.models
    setTestAccounts([codexAccount()])
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-9-mini",
          object: "model",
          name: "GPT-9 Mini",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          supported_endpoints: ["/v1/responses"],
          capabilities: {
            family: "codex",
            object: "capabilities",
            supports: { streaming: true },
            tokenizer: "unknown",
            type: "chat",
          },
        },
      ],
    }

    try {
      const response = await server.fetch(
        adminRequest("http://localhost/admin/api/usage/pricing"),
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        pricing: Record<string, { promptPricePer1k: number }>
        sources: Record<string, string>
      }
      expect(body.sources["gpt-9-mini"]).toBe("models-dev")
      expect(body.pricing["gpt-9-mini"].promptPricePer1k).toBeCloseTo(
        0.0002,
        10,
      )
    } finally {
      setTestAccounts(originalAccounts)
      state.models = originalModelsData
    }
  })
})

describe("GET /admin/api/usage/pricing", () => {
  test("returns models.dev and unmatched pricing sources", async () => {
    const response = await server.fetch(
      adminRequest("http://localhost/admin/api/usage/pricing"),
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
