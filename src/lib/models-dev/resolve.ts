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
  lookupGlobalModelEfforts,
  lookupGlobalModelPrice,
  lookupProviderModelContext,
  lookupProviderModelEfforts,
  lookupProviderModelPrice,
} from "~/lib/models-dev/catalog"
import {
  getModelsDevCatalog,
  getModelsDevContextIndexes,
  getModelsDevEffortsIndexes,
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
/**
 * One model id's route through the catalog: the candidate spellings and the
 * models.dev provider ids to ask first. A `provider/model` reference that
 * names a catalog provider is exclusive — the answer is that provider's.
 */
interface CatalogLookupPath {
  candidates: Array<string>
  providerIds: Array<string>
  nativeModelId: string
  provider?: string
  exclusive: boolean
}

function catalogLookupPath(
  modelId: string,
  providerHint?: string,
  catalog: ModelsDevCatalog | null = getModelsDevCatalog(),
): CatalogLookupPath | null {
  const raw = modelId.trim().toLowerCase()
  const channel = raw.includes("/") ? raw.split("/").at(0)! : ""
  if (channel && catalog?.[channel] && !providerHint) {
    const nativeModelId = raw.slice(channel.length + 1)
    const candidates = buildPricingLookupCandidates(nativeModelId)
    if (candidates.length === 0) return null
    return {
      candidates,
      providerIds: [channel],
      nativeModelId,
      provider: channel,
      exclusive: true,
    }
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
  if (candidates.length === 0) return null

  const buckets =
    provider ?
      isProviderId(provider) ?
        (MODELS_DEV_PROVIDER_PRIORITY[provider] ?? [provider])
      : [provider]
    : []
  const windsurfBuckets =
    provider === "windsurf" ? inferWindsurfVendorBucket(nativeModelId) : []
  return {
    candidates,
    providerIds: [
      ...buckets,
      ...windsurfBuckets.filter((bucket) => !buckets.includes(bucket)),
    ],
    nativeModelId,
    provider,
    exclusive: false,
  }
}

/**
 * Ask the path's providers first, then (unless the caller says otherwise) the
 * global index. Pricing refuses the global fallback once a provider is hinted:
 * a catalog insertion order is not a billing policy.
 */
function walkCatalog<T>(
  path: CatalogLookupPath,
  providerLookup: (
    providerIds: Array<string>,
    candidate: string,
  ) => T | null | undefined,
  globalLookup: (candidate: string) => T | null | undefined,
  fallbackWhenHinted = true,
): T | undefined {
  if (path.providerIds.length > 0) {
    for (const candidate of path.candidates) {
      const hit = providerLookup(path.providerIds, candidate)
      if (hit !== null && hit !== undefined) return hit
    }
    if (path.exclusive || !fallbackWhenHinted) return undefined
  }
  for (const candidate of path.candidates) {
    const hit = globalLookup(candidate)
    if (hit !== null && hit !== undefined) return hit
  }
  return undefined
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

export function resolveModelsDevPriceDetailed(
  modelId: string,
  providerHint?: string,
): ResolvedModelPricing | null {
  const indexes = getModelsDevIndexes()
  const catalog = getModelsDevCatalog()
  if (!indexes || !catalog) return null
  return resolveCatalogPrice(indexes, catalog, modelId, providerHint)
}

export function resolveCatalogPrice(
  indexes: ModelsDevPriceIndexes,
  catalog: ModelsDevCatalog,
  modelId: string,
  providerHint?: string,
): ResolvedModelPricing | null {
  const path = catalogLookupPath(modelId, providerHint, catalog)
  if (!path) return null

  const pricing = walkCatalog(
    path,
    (providerIds, candidate) =>
      lookupProviderModelPrice(indexes, providerIds, candidate),
    (candidate) => lookupGlobalModelPrice(indexes, candidate),
    false,
  )
  if (!pricing) return null

  const fastWindsurf =
    !path.exclusive
    && path.provider === "windsurf"
    && path.nativeModelId.toLowerCase().endsWith("-fast")
  return {
    ...(fastWindsurf ?
      applyFastMultiplier(pricing, path.nativeModelId)
    : pricing),
    source: "models-dev",
  }
}

/**
 * The context window models.dev names for a model, or undefined when the
 * catalog has not loaded or does not know it.
 */
export function resolveModelsDevContext(
  modelId: string,
  providerHint?: ProviderId,
): number | undefined {
  const indexes = getModelsDevContextIndexes()
  const path = indexes ? catalogLookupPath(modelId, providerHint) : null
  if (!indexes || !path) return undefined
  return walkCatalog(
    path,
    (providerIds, candidate) =>
      lookupProviderModelContext(indexes, providerIds, candidate),
    (candidate) => lookupGlobalModelContext(indexes, candidate),
  )
}

/**
 * The reasoning levels models.dev says a model takes, or undefined when the
 * catalog has not loaded or names none. Without a matching provider it falls
 * back to the level set most providers agree on (magpie's `mostListed`).
 */
export function resolveModelsDevEfforts(
  modelId: string,
  providerHint?: ProviderId,
): Array<string> | undefined {
  const indexes = getModelsDevEffortsIndexes()
  const path = indexes ? catalogLookupPath(modelId, providerHint) : null
  if (!indexes || !path) return undefined
  return walkCatalog(
    path,
    (providerIds, candidate) =>
      lookupProviderModelEfforts(indexes, providerIds, candidate),
    (candidate) => lookupGlobalModelEfforts(indexes, candidate),
  )
}
