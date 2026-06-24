import type {
  ModelPricingPer1k,
  ResolvedModelPricing,
} from "~/lib/models-dev/types"

import { parseModelReference } from "~/lib/accounts"
import {
  lookupGlobalModelPrice,
  lookupProviderModelPrice,
} from "~/lib/models-dev/catalog"
import { getModelsDevIndexes } from "~/lib/models-dev/client"
import {
  buildPricingLookupCandidates,
  inferWindsurfVendorBucket,
} from "~/lib/models-dev/normalize"
import { MODELS_DEV_PROVIDER_PRIORITY } from "~/lib/models-dev/provider-map"

function lookupCandidates(
  providerIds: Array<string>,
  candidates: Array<string>,
): ModelPricingPer1k | null {
  const indexes = getModelsDevIndexes()
  if (!indexes) {
    return null
  }

  for (const candidate of candidates) {
    const providerMatch = lookupProviderModelPrice(
      indexes,
      providerIds,
      candidate,
    )
    if (providerMatch) {
      return providerMatch
    }
  }

  for (const candidate of candidates) {
    const globalMatch = lookupGlobalModelPrice(indexes, candidate)
    if (globalMatch) {
      return globalMatch
    }
  }

  return null
}

export function resolveModelsDevPrice(
  modelId: string,
): ModelPricingPer1k | null {
  const resolved = resolveModelsDevPriceDetailed(modelId)
  if (!resolved || resolved.source !== "models-dev") {
    return null
  }
  return {
    promptPricePer1k: resolved.promptPricePer1k,
    completionPricePer1k: resolved.completionPricePer1k,
    cacheReadPricePer1k: resolved.cacheReadPricePer1k,
    cacheWritePricePer1k: resolved.cacheWritePricePer1k,
  }
}

export function resolveModelsDevPriceDetailed(
  modelId: string,
): ResolvedModelPricing | null {
  const indexes = getModelsDevIndexes()
  if (!indexes) {
    return null
  }

  const parsed = parseModelReference(modelId)
  const provider = parsed.provider
  const candidates = buildPricingLookupCandidates(
    parsed.nativeModelId,
    provider,
  )

  if (candidates.length === 0) {
    return null
  }

  const providerBuckets =
    provider ? (MODELS_DEV_PROVIDER_PRIORITY[provider] ?? []) : []
  const windsurfBuckets =
    provider === "windsurf" ?
      inferWindsurfVendorBucket(parsed.nativeModelId)
    : []

  const orderedProviderIds = [
    ...providerBuckets,
    ...windsurfBuckets.filter((bucket) => !providerBuckets.includes(bucket)),
  ]

  const pricing = lookupCandidates(orderedProviderIds, candidates)
  if (!pricing) {
    return null
  }

  return {
    ...pricing,
    source: "models-dev",
  }
}
