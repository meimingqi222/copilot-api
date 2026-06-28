export interface ModelsDevCost {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
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
}

export type ModelPricingSource =
  | "manual"
  | "models-dev"
  | "builtin"
  | "unmatched"

export interface ResolvedModelPricing extends ModelPricingPer1k {
  source: ModelPricingSource
}
