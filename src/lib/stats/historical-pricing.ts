import type { ModelPricingPer1k } from "~/lib/models-dev/types"
import { calculateModelCost } from "~/lib/models-dev/tier"

export function historicalCostEstimate(
  pricing: ModelPricingPer1k | null | undefined,
  row: {
    provider: string | null
    prompt_tokens: number
    completion_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
  },
): number | null {
  if (
    !pricing
    || row.provider === "codex"
    || row.cache_write_tokens > 0
    || pricing.contextTierAbove
    || pricing.contextTiers?.length
  )
    return null
  return calculateModelCost(pricing, {
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  })
}
