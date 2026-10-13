import type {
  ModelPricingPer1k,
  ModelsDevCatalog,
  ResolvedModelPricing,
} from "~/lib/models-dev/types"
import { isProviderId, type ProviderId } from "~/lib/provider-config"

import type { ModelsDevPriceIndexes } from "~/lib/models-dev/catalog"

import { parseModelReference } from "~/lib/route-target/model-reference"
import {
  lookupGlobalModelContext,
  lookupGlobalModelPrice,
  lookupProviderModelContext,
  lookupProviderModelPrice,
} from "~/lib/models-dev/catalog"
import {
  getModelsDevCatalog,
  getModelsDevContextIndexes,
  getModelsDevIndexes,
} from "~/lib/models-dev/client"
import {
  buildPricingLookupCandidates,
  inferWindsurfVendorBucket,
} from "~/lib/models-dev/normalize"
import { MODELS_DEV_PROVIDER_PRIORITY } from "~/lib/models-dev/provider-map"

/**
 * Windsurf "fast" variant pricing multipliers.
 *
 * Source: Windsurf pricing documentation — fast variants trade latency
 * for a per-token surcharge on top of the base model price.
 *   - OpenAI GPT-5.x fast: 2x base price
 *   - Claude Opus 4.8 fast: 2x base price (newer tier)
 *   - Older Claude (4.1/4.6/4.7) fast: 6x base price (legacy tier)
 * Other vendors (Google, xAI, etc.) currently have no documented fast
 * surcharge and fall through to 1x.
 */
const FAST_MULTIPLIER_OPENAI = 2
const FAST_MULTIPLIER_CLAUDE_NEW = 2
const FAST_MULTIPLIER_CLAUDE_LEGACY = 6
const CLAUDE_NEW_FAST_PATTERNS = ["claude-opus-4-8", "claude-opus-4.8"]

function inferFastMultiplier(modelId: string): number {
  const id = modelId.toLowerCase()
  const buckets = inferWindsurfVendorBucket(modelId)

  if (buckets.includes("openai")) {
    return FAST_MULTIPLIER_OPENAI
  }

  if (buckets.includes("anthropic")) {
    if (CLAUDE_NEW_FAST_PATTERNS.some((p) => id.includes(p))) {
      return FAST_MULTIPLIER_CLAUDE_NEW
    }
    return FAST_MULTIPLIER_CLAUDE_LEGACY
  }

  return 1
}

function applyFastMultiplier(
  basePricing: ModelPricingPer1k,
  modelId: string,
): ModelPricingPer1k {
  const multiplier = inferFastMultiplier(modelId)
  if (multiplier === 1) {
    return basePricing
  }

  return {
    promptPricePer1k: basePricing.promptPricePer1k * multiplier,
    completionPricePer1k: basePricing.completionPricePer1k * multiplier,
    cacheReadPricePer1k: basePricing.cacheReadPricePer1k * multiplier,
    cacheWritePricePer1k: basePricing.cacheWritePricePer1k * multiplier,
    contextTierAbove:
      basePricing.contextTierAbove ?
        {
          thresholdTokens: basePricing.contextTierAbove.thresholdTokens,
          promptPricePer1k:
            basePricing.contextTierAbove.promptPricePer1k * multiplier,
          completionPricePer1k:
            basePricing.contextTierAbove.completionPricePer1k * multiplier,
          cacheReadPricePer1k:
            basePricing.contextTierAbove.cacheReadPricePer1k * multiplier,
          cacheWritePricePer1k:
            basePricing.contextTierAbove.cacheWritePricePer1k * multiplier,
        }
      : basePricing.contextTierAbove,
    contextTiers: basePricing.contextTiers?.map((tier) => ({
      thresholdTokens: tier.thresholdTokens,
      promptPricePer1k: tier.promptPricePer1k * multiplier,
      completionPricePer1k: tier.completionPricePer1k * multiplier,
      cacheReadPricePer1k: tier.cacheReadPricePer1k * multiplier,
      cacheWritePricePer1k: tier.cacheWritePricePer1k * multiplier,
    })),
  }
}

function lookupCandidates(
  indexes: ModelsDevPriceIndexes,
  providerIds: Array<string>,
  candidates: Array<string>,
): ModelPricingPer1k | null {
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

  if (providerIds.length > 0) return null

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
    contextTierAbove: resolved.contextTierAbove,
    contextTiers: resolved.contextTiers,
  }
}

function priceProviderBuckets(provider: string | undefined): Array<string> {
  if (!provider) return []
  if (isProviderId(provider))
    return MODELS_DEV_PROVIDER_PRIORITY[provider] ?? [provider]
  return [provider]
}

export function resolveModelsDevPriceDetailed(
  modelId: string,
  providerHint?: string,
): ResolvedModelPricing | null {
  const indexes = getModelsDevIndexes()
  if (!indexes) {
    return null
  }

  const catalog = getModelsDevCatalog()
  if (!catalog) return null
  return resolveCatalogPrice(indexes, catalog, modelId, providerHint)
}

export function resolveCatalogPrice(
  indexes: ModelsDevPriceIndexes,
  catalog: ModelsDevCatalog,
  modelId: string,
  providerHint?: string,
): ResolvedModelPricing | null {
  // Catalog channel/full-model references take precedence over routing aliases.
  const raw = modelId.trim().toLowerCase()
  const direct = indexes.byProviderModel.get(raw)
  if (direct && !providerHint) return { ...direct, source: "models-dev" }
  const channel = raw.split("/")[0]!
  const explicitChannel = catalog[channel]
  if (explicitChannel && !providerHint) {
    const candidates = buildPricingLookupCandidates(
      raw.slice(channel.length + 1),
    )
    for (const candidate of candidates) {
      const price = lookupProviderModelPrice(indexes, [channel], candidate)
      if (price) return { ...price, source: "models-dev" }
    }
    return null
  }
  const parsed = parseModelReference(modelId)
  const provider = providerHint ?? parsed.provider
  const nativeModelId =
    providerHint && parsed.provider !== providerHint ?
      raw
    : parsed.nativeModelId
  const candidates = buildPricingLookupCandidates(
    nativeModelId,
    provider && isProviderId(provider) ? provider : undefined,
  )

  if (candidates.length === 0) {
    return null
  }

  const providerBuckets = priceProviderBuckets(provider)
  if (provider === "windsurf") {
    const nativeQuote = lookupProviderModelPrice(
      indexes,
      ["windsurf"],
      nativeModelId,
    )
    if (nativeQuote) return { ...nativeQuote, source: "models-dev" }
  }
  const windsurfBuckets =
    provider === "windsurf" ? inferWindsurfVendorBucket(nativeModelId) : []

  const orderedProviderIds = [
    ...providerBuckets,
    ...windsurfBuckets.filter((bucket) => !providerBuckets.includes(bucket)),
  ]

  if (provider && orderedProviderIds.length === 0) return null
  const pricing = lookupCandidates(indexes, orderedProviderIds, candidates)
  if (!pricing) {
    return null
  }

  const hasFast = nativeModelId.toLowerCase().endsWith("-fast")
  const isWindsurfLike = provider === "windsurf"
  const resolvedPricing =
    hasFast && isWindsurfLike ?
      applyFastMultiplier(pricing, nativeModelId)
    : pricing

  return {
    ...resolvedPricing,
    source: "models-dev",
  }
}

/**
 * The context window models.dev names for a model, or undefined when the
 * catalog has not loaded or does not know it. Mirrors the price lookup's
 * candidate + provider-bucket walk, so a connection that stores only a bare or
 * vendor-namespaced id still matches.
 */
export function resolveModelsDevContext(
  modelId: string,
  providerHint?: ProviderId,
): number | undefined {
  const indexes = getModelsDevContextIndexes()
  if (!indexes) return undefined

  const parsed = parseModelReference(modelId)
  const provider = parsed.provider ?? providerHint
  const candidates = buildPricingLookupCandidates(
    parsed.nativeModelId,
    provider,
  )
  if (candidates.length === 0) return undefined

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

  for (const candidate of candidates) {
    const providerMatch = lookupProviderModelContext(
      indexes,
      orderedProviderIds,
      candidate,
    )
    if (providerMatch !== undefined) return providerMatch
  }
  for (const candidate of candidates) {
    const globalMatch = lookupGlobalModelContext(indexes, candidate)
    if (globalMatch !== undefined) return globalMatch
  }
  return undefined
}
