import type {
  ModelPricingPer1k,
  ResolvedModelPricing,
} from "~/lib/models-dev/types"
import type { ProviderId } from "~/lib/provider-config"

import { parseModelReference } from "~/lib/legacy-accounts"
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
  }
}

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
  providerHint?: ProviderId,
): ResolvedModelPricing | null {
  const indexes = getModelsDevIndexes()
  if (!indexes) {
    return null
  }

  const parsed = parseModelReference(modelId)
  const provider = parsed.provider ?? providerHint
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

  const hasFast = parsed.nativeModelId.toLowerCase().endsWith("-fast")
  const isWindsurfLike =
    provider === "windsurf"
    || (!provider && inferWindsurfVendorBucket(parsed.nativeModelId).length > 0)
  const resolvedPricing =
    hasFast && isWindsurfLike ?
      applyFastMultiplier(pricing, parsed.nativeModelId)
    : pricing

  return {
    ...resolvedPricing,
    source: "models-dev",
  }
}
