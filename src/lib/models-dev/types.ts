export interface ModelsDevTierRate {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tier: {
    type: string
    size: number
  }
}

export interface ModelsDevTierCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}

export interface ModelsDevCost {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  /** 新格式：按上下文长度分档，取 type=context 的最小 size 一档。 */
  tiers?: Array<ModelsDevTierRate>
  /** 旧格式：>200k 整单跳价（与 tiers[0] 同义）。 */
  context_over_200k?: ModelsDevTierCost
}

export interface ModelsDevModel {
  id: string
  name?: string
  cost?: ModelsDevCost
}

export interface ModelsDevProvider {
  id: string
  name?: string
  models: Record<string, ModelsDevModel>
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>

export interface ModelPricingPer1k {
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k: number
  cacheWritePricePer1k: number
  /**
   * 长上下文阶梯（整单跳价）：当单次请求 prompt 总量
   * （普通 input + cacheRead + cacheWrite）> thresholdTokens 时，
   * 整单按 extended 价格结算，而非仅超额部分。
   * 为 null/undefined 表示无分档。
   */
  contextTierAbove?: ContextTierPricingPer1k | null
}

export interface ContextTierPricingPer1k {
  thresholdTokens: number
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k: number
  cacheWritePricePer1k: number
}

export type ModelPricingSource =
  | "manual"
  | "models-dev"
  | "builtin"
  | "unmatched"

export interface ResolvedModelPricing extends ModelPricingPer1k {
  source: ModelPricingSource
}
