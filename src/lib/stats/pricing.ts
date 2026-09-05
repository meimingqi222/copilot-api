// 模型定价相关逻辑（从 stats-store.ts 拆分而来，纯代码移动，无逻辑变更）

import { Database } from "bun:sqlite"

import type {
  ContextTierPricingPer1k,
  ResolvedModelPricing,
} from "~/lib/models-dev"
import type { ProviderId } from "~/lib/provider-config"

import { getDefaultModelPrice } from "~/lib/default-prices"
import { resolveModelsDevPriceDetailed } from "~/lib/models-dev"

export interface ManualPricingInput {
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k?: number
  cacheWritePricePer1k?: number
  contextThresholdTokens?: number | null
  extendedPromptPricePer1k?: number | null
  extendedCompletionPricePer1k?: number | null
  extendedCacheReadPricePer1k?: number | null
  extendedCacheWritePricePer1k?: number | null
}

function toContextTier(row: {
  prompt_price_per_1k: number
  completion_price_per_1k: number
  cache_read_price_per_1k: number
  cache_write_price_per_1k: number
  context_threshold_tokens?: number | null
  extended_prompt_price_per_1k?: number | null
  extended_completion_price_per_1k?: number | null
  extended_cache_read_price_per_1k?: number | null
  extended_cache_write_price_per_1k?: number | null
}): ContextTierPricingPer1k | null {
  const threshold = row.context_threshold_tokens
  if (!threshold || !Number.isFinite(threshold) || threshold <= 0) {
    return null
  }
  const hasAnyExtended =
    (row.extended_prompt_price_per_1k !== null
      && row.extended_prompt_price_per_1k !== undefined)
    || (row.extended_completion_price_per_1k !== null
      && row.extended_completion_price_per_1k !== undefined)
    || (row.extended_cache_read_price_per_1k !== null
      && row.extended_cache_read_price_per_1k !== undefined)
    || (row.extended_cache_write_price_per_1k !== null
      && row.extended_cache_write_price_per_1k !== undefined)
  if (!hasAnyExtended) return null
  // 防呆：高档价全 0 几乎不可能是真实定价（多为误填），此时忽略分档、
  // 回退基础价，避免 >阈值 的整单被按 0 计费。
  if (
    (row.extended_prompt_price_per_1k ?? 0) === 0
    && (row.extended_completion_price_per_1k ?? 0) === 0
    && (row.extended_cache_read_price_per_1k ?? 0) === 0
    && (row.extended_cache_write_price_per_1k ?? 0) === 0
  ) {
    return null
  }
  return {
    thresholdTokens: Math.floor(threshold),
    // 未单独填写的高档价回退基础价：空输入表示“同基础价”，而非免费。
    promptPricePer1k:
      row.extended_prompt_price_per_1k ?? row.prompt_price_per_1k ?? 0,
    completionPricePer1k:
      row.extended_completion_price_per_1k ?? row.completion_price_per_1k ?? 0,
    cacheReadPricePer1k:
      row.extended_cache_read_price_per_1k ?? row.cache_read_price_per_1k ?? 0,
    cacheWritePricePer1k:
      row.extended_cache_write_price_per_1k
      ?? row.cache_write_price_per_1k
      ?? 0,
  }
}

export function setModelPricing(
  db: Database,
  model: string,
  pricing: ManualPricingInput,
): void {
  const threshold =
    (
      pricing.contextThresholdTokens !== null
      && pricing.contextThresholdTokens !== undefined
      && Number.isFinite(pricing.contextThresholdTokens)
      && pricing.contextThresholdTokens > 0
    ) ?
      Math.floor(pricing.contextThresholdTokens)
    : null
  const stmt = db.prepare(`
    INSERT INTO model_pricing (
      model, prompt_price_per_1k, completion_price_per_1k,
      cache_read_price_per_1k, cache_write_price_per_1k,
      context_threshold_tokens,
      extended_prompt_price_per_1k, extended_completion_price_per_1k,
      extended_cache_read_price_per_1k, extended_cache_write_price_per_1k,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET
      prompt_price_per_1k = excluded.prompt_price_per_1k,
      completion_price_per_1k = excluded.completion_price_per_1k,
      cache_read_price_per_1k = excluded.cache_read_price_per_1k,
      cache_write_price_per_1k = excluded.cache_write_price_per_1k,
      context_threshold_tokens = excluded.context_threshold_tokens,
      extended_prompt_price_per_1k = excluded.extended_prompt_price_per_1k,
      extended_completion_price_per_1k = excluded.extended_completion_price_per_1k,
      extended_cache_read_price_per_1k = excluded.extended_cache_read_price_per_1k,
      extended_cache_write_price_per_1k = excluded.extended_cache_write_price_per_1k,
      updated_at = excluded.updated_at
  `)
  stmt.run(
    model,
    pricing.promptPricePer1k,
    pricing.completionPricePer1k,
    pricing.cacheReadPricePer1k ?? 0,
    pricing.cacheWritePricePer1k ?? 0,
    threshold,
    pricing.extendedPromptPricePer1k ?? null,
    pricing.extendedCompletionPricePer1k ?? null,
    pricing.extendedCacheReadPricePer1k ?? null,
    pricing.extendedCacheWritePricePer1k ?? null,
    Date.now(),
  )
}

export function hasManualModelPricing(db: Database, model: string): boolean {
  const stmt = db.prepare(`
    SELECT 1 FROM model_pricing WHERE model = ? LIMIT 1
  `)
  return stmt.get(model) !== undefined
}

export function getManualModelPricing(
  db: Database,
  model: string,
): {
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k: number
  cacheWritePricePer1k: number
  contextTierAbove: ContextTierPricingPer1k | null
} | null {
  const stmt = db.prepare(`
    SELECT * FROM model_pricing WHERE model = ?
  `)
  const row = stmt.get(model) as
    | {
        prompt_price_per_1k: number
        completion_price_per_1k: number
        cache_read_price_per_1k: number
        cache_write_price_per_1k: number
        context_threshold_tokens?: number | null
        extended_prompt_price_per_1k?: number | null
        extended_completion_price_per_1k?: number | null
        extended_cache_read_price_per_1k?: number | null
        extended_cache_write_price_per_1k?: number | null
      }
    | undefined

  if (!row) {
    return null
  }

  return {
    promptPricePer1k: row.prompt_price_per_1k,
    completionPricePer1k: row.completion_price_per_1k,
    cacheReadPricePer1k: row.cache_read_price_per_1k,
    cacheWritePricePer1k: row.cache_write_price_per_1k,
    contextTierAbove: toContextTier(row),
  }
}

export function resolveModelPricing(
  db: Database,
  model: string,
  provider?: ProviderId,
): ResolvedModelPricing | null {
  const manual = getManualModelPricing(db, model)
  if (manual) {
    return {
      ...manual,
      source: "manual",
    }
  }
  const fromModelsDev = resolveModelsDevPriceDetailed(model, provider)
  if (fromModelsDev) {
    return fromModelsDev
  }

  const builtin = getDefaultModelPrice(model)
  if (builtin) {
    return {
      ...builtin,
      contextTierAbove: null,
      source: "builtin",
    }
  }

  return null
}

export function getModelPricing(
  db: Database,
  model: string,
  provider?: ProviderId,
): {
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k: number
  cacheWritePricePer1k: number
  contextTierAbove: ContextTierPricingPer1k | null
} | null {
  const resolved = resolveModelPricing(db, model, provider)
  if (!resolved) {
    return null
  }
  return {
    promptPricePer1k: resolved.promptPricePer1k,
    completionPricePer1k: resolved.completionPricePer1k,
    cacheReadPricePer1k: resolved.cacheReadPricePer1k,
    cacheWritePricePer1k: resolved.cacheWritePricePer1k,
    contextTierAbove: resolved.contextTierAbove ?? null,
  }
}

export function getAllModelPricing(db: Database): Array<{
  model: string
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k: number
  cacheWritePricePer1k: number
  contextTierAbove: ContextTierPricingPer1k | null
  updatedAt: number
}> {
  const stmt = db.prepare(`
    SELECT * FROM model_pricing ORDER BY model
  `)
  const rows = stmt.all() as Array<{
    model: string
    prompt_price_per_1k: number
    completion_price_per_1k: number
    cache_read_price_per_1k: number
    cache_write_price_per_1k: number
    context_threshold_tokens?: number | null
    extended_prompt_price_per_1k?: number | null
    extended_completion_price_per_1k?: number | null
    extended_cache_read_price_per_1k?: number | null
    extended_cache_write_price_per_1k?: number | null
    updated_at: number
  }>

  return rows.map((row) => ({
    model: row.model,
    promptPricePer1k: row.prompt_price_per_1k,
    completionPricePer1k: row.completion_price_per_1k,
    cacheReadPricePer1k: row.cache_read_price_per_1k,
    cacheWritePricePer1k: row.cache_write_price_per_1k,
    contextTierAbove: toContextTier(row),
    updatedAt: row.updated_at,
  }))
}
