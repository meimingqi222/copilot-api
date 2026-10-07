interface ModelsDevTierRate {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tier: {
    type: string
    size: number
  }
}

interface ModelsDevTierCost {
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
  /** 新格式：按上下文长度分档，保留全部 type=context 档位。 */
  tiers?: Array<ModelsDevTierRate>
  /** 旧格式：>200k 整单跳价（与 tiers[0] 同义）。 */
  context_over_200k?: ModelsDevTierCost
}

interface ModelsDevLimit {
  /** Context window in tokens. */
  context?: number
  /** Max output tokens. */
  output?: number
}

export interface ModelsDevModel {
  id: string
  name?: string
  cost?: ModelsDevCost
  /** Context / output window, when models.dev names them. */
  limit?: ModelsDevLimit
}

interface ModelsDevProvider {
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
  /** 全部上下文档位；存在时优先于兼容字段 contextTierAbove。 */
  contextTiers?: Array<ContextTierPricingPer1k>
}

export interface ContextTierPricingPer1k {
  thresholdTokens: number
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k: number
  cacheWritePricePer1k: number
}

type ModelPricingSource =
  | "manual"
  | "models-dev"
  | "devin-official"
  | "builtin"
  | "unmatched"

export interface ResolvedModelPricing extends ModelPricingPer1k {
  source: ModelPricingSource
}
