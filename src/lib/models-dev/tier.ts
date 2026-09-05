import type {
  ContextTierPricingPer1k,
  ModelPricingPer1k,
} from "~/lib/models-dev/types"

/** 单次请求 prompt 总量：普通 input + 缓存读 + 缓存写。 */
export function promptTotalForTier(
  promptTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  return (
    Math.max(0, promptTokens)
    + Math.max(0, cacheReadTokens)
    + Math.max(0, cacheWriteTokens)
  )
}

/** 是否触发长上下文阶梯（整单跳价，非超额累进）。 */
export function isContextTierTriggered(
  pricing: Pick<ModelPricingPer1k, "contextTierAbove">,
  promptTotal: number,
): boolean {
  const tier = pricing.contextTierAbove
  if (!tier || !Number.isFinite(tier.thresholdTokens)) return false
  return promptTotal > tier.thresholdTokens
}

/** 按 prompt 总量选出本单实际生效的一套单价。 */
export function selectEffectivePricing(
  pricing: ModelPricingPer1k,
  promptTotal: number,
): {
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k: number
  cacheWritePricePer1k: number
  tiered: boolean
  tier: ContextTierPricingPer1k | null
} {
  const tier = pricing.contextTierAbove ?? null
  if (tier && promptTotal > tier.thresholdTokens) {
    return {
      promptPricePer1k: tier.promptPricePer1k,
      completionPricePer1k: tier.completionPricePer1k,
      cacheReadPricePer1k: tier.cacheReadPricePer1k,
      cacheWritePricePer1k: tier.cacheWritePricePer1k,
      tiered: true,
      tier,
    }
  }
  return {
    promptPricePer1k: pricing.promptPricePer1k,
    completionPricePer1k: pricing.completionPricePer1k,
    cacheReadPricePer1k: pricing.cacheReadPricePer1k,
    cacheWritePricePer1k: pricing.cacheWritePricePer1k,
    tiered: false,
    tier,
  }
}

/** 阶梯感知的整单费用（单位 USD）。 */
export function calculateModelCost(
  pricing: ModelPricingPer1k,
  tokens: {
    promptTokens: number
    completionTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  },
): number {
  const cacheReadTokens = tokens.cacheReadTokens ?? 0
  const cacheWriteTokens = tokens.cacheWriteTokens ?? 0
  const effective = selectEffectivePricing(
    pricing,
    promptTotalForTier(tokens.promptTokens, cacheReadTokens, cacheWriteTokens),
  )
  return (
    (tokens.promptTokens / 1000) * effective.promptPricePer1k
    + (tokens.completionTokens / 1000) * effective.completionPricePer1k
    + (cacheReadTokens / 1000) * effective.cacheReadPricePer1k
    + (cacheWriteTokens / 1000) * effective.cacheWritePricePer1k
  )
}
