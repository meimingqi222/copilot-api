import type {
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

function costToPer1k(cost: ModelsDevCost): ModelPricingPer1k {
  return {
    promptPricePer1k: cost.input / 1000,
    completionPricePer1k: cost.output / 1000,
    cacheReadPricePer1k: (cost.cache_read ?? 0) / 1000,
    cacheWritePricePer1k: (cost.cache_write ?? 0) / 1000,
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
