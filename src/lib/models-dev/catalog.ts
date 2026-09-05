import type {
  ContextTierPricingPer1k,
  ModelPricingPer1k,
  ModelsDevCatalog,
  ModelsDevCost,
  ModelsDevModel,
} from "~/lib/models-dev/types"

import { GLOBAL_MODEL_PROVIDER_PRIORITY } from "~/lib/models-dev/provider-map"

export interface ModelsDevPriceIndexes {
  byProviderModel: Map<string, ModelPricingPer1k>
  byModelId: Map<
    string,
    Array<{ provider: string; pricing: ModelPricingPer1k }>
  >
}

function extractContextTier(
  cost: ModelsDevCost,
): ContextTierPricingPer1k | null {
  const contextTiers = (cost.tiers ?? [])
    .filter(
      (t) =>
        t?.tier?.type === "context"
        && Number.isFinite(t.tier.size)
        && t.tier.size > 0,
    )
    .sort((a, b) => a.tier.size - b.tier.size)
  const first = contextTiers[0]
  if (first) {
    return {
      thresholdTokens: first.tier.size,
      promptPricePer1k: (first.input ?? cost.input) / 1000,
      completionPricePer1k: (first.output ?? cost.output) / 1000,
      cacheReadPricePer1k: (first.cache_read ?? cost.cache_read ?? 0) / 1000,
      cacheWritePricePer1k: (first.cache_write ?? cost.cache_write ?? 0) / 1000,
    }
  }
  if (cost.context_over_200k) {
    const t = cost.context_over_200k
    return {
      thresholdTokens: 200_000,
      promptPricePer1k: (t.input ?? cost.input) / 1000,
      completionPricePer1k: (t.output ?? cost.output) / 1000,
      cacheReadPricePer1k: (t.cache_read ?? cost.cache_read ?? 0) / 1000,
      cacheWritePricePer1k: (t.cache_write ?? cost.cache_write ?? 0) / 1000,
    }
  }
  return null
}

function costToPer1k(cost: ModelsDevCost): ModelPricingPer1k {
  const tier = extractContextTier(cost)
  const base = {
    promptPricePer1k: cost.input / 1000,
    completionPricePer1k: cost.output / 1000,
    cacheReadPricePer1k: (cost.cache_read ?? 0) / 1000,
    cacheWritePricePer1k: (cost.cache_write ?? 0) / 1000,
  }
  // 跳过与基础价完全相同的“假分档”（部分网关条目会原样回填）。
  if (
    tier
    && tier.promptPricePer1k === base.promptPricePer1k
    && tier.completionPricePer1k === base.completionPricePer1k
    && tier.cacheReadPricePer1k === base.cacheReadPricePer1k
    && tier.cacheWritePricePer1k === base.cacheWritePricePer1k
  ) {
    return { ...base, contextTierAbove: null }
  }
  return {
    ...base,
    contextTierAbove: tier,
  }
}

function collectModelCosts(
  providerId: string,
  modelKey: string,
  model: ModelsDevModel,
  indexes: ModelsDevPriceIndexes,
): void {
  if (!model.cost) {
    return
  }
  const pricing = costToPer1k(model.cost)
  const nativeId = (model.id || modelKey).trim().toLowerCase()
  const slashParts = nativeId.includes("/") ? nativeId.split("/") : []
  const tailId = slashParts.at(-1) ?? nativeId
  const keys = new Set<string>([
    nativeId,
    modelKey.trim().toLowerCase(),
    tailId,
  ])

  for (const key of keys) {
    indexes.byProviderModel.set(`${providerId}/${key}`, pricing)
    const existing = indexes.byModelId.get(key) ?? []
    if (!existing.some((entry) => entry.provider === providerId)) {
      existing.push({ provider: providerId, pricing })
      indexes.byModelId.set(key, existing)
    }
  }
}

export function buildModelsDevPriceIndexes(
  catalog: ModelsDevCatalog,
): ModelsDevPriceIndexes {
  const indexes: ModelsDevPriceIndexes = {
    byProviderModel: new Map(),
    byModelId: new Map(),
  }

  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelKey, model] of Object.entries(provider.models)) {
      collectModelCosts(providerId, modelKey, model, indexes)
    }
  }

  for (const [, entries] of indexes.byModelId) {
    entries.sort((left, right) => {
      const leftIndex = GLOBAL_MODEL_PROVIDER_PRIORITY.indexOf(
        left.provider as (typeof GLOBAL_MODEL_PROVIDER_PRIORITY)[number],
      )
      const rightIndex = GLOBAL_MODEL_PROVIDER_PRIORITY.indexOf(
        right.provider as (typeof GLOBAL_MODEL_PROVIDER_PRIORITY)[number],
      )
      const normalizedLeft =
        leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex
      const normalizedRight =
        rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex
      return normalizedLeft - normalizedRight
    })
  }

  return indexes
}

export function lookupProviderModelPrice(
  indexes: ModelsDevPriceIndexes,
  providerIds: Array<string>,
  modelId: string,
): ModelPricingPer1k | null {
  const normalized = modelId.trim().toLowerCase()
  for (const providerId of providerIds) {
    const direct = indexes.byProviderModel.get(`${providerId}/${normalized}`)
    if (direct) {
      return direct
    }
  }
  return null
}

export function lookupGlobalModelPrice(
  indexes: ModelsDevPriceIndexes,
  modelId: string,
): ModelPricingPer1k | null {
  const normalized = modelId.trim().toLowerCase()
  const entries = indexes.byModelId.get(normalized)
  if (!entries || entries.length === 0) {
    return null
  }
  return entries[0]?.pricing ?? null
}
