// 模型定价相关逻辑（从 stats-store.ts 拆分而来，纯代码移动，无逻辑变更）

import { Database } from "bun:sqlite"

import type { ResolvedModelPricing } from "~/lib/models-dev"
import type { ProviderId } from "~/lib/provider-config"

import { getDefaultModelPrice } from "~/lib/default-prices"
import { resolveModelsDevPriceDetailed } from "~/lib/models-dev"

export function setModelPricing(
  db: Database,
  model: string,
  pricing: {
    promptPricePer1k: number
    completionPricePer1k: number
    cacheReadPricePer1k?: number
    cacheWritePricePer1k?: number
  },
): void {
  const stmt = db.prepare(`
    INSERT INTO model_pricing (
      model, prompt_price_per_1k, completion_price_per_1k,
      cache_read_price_per_1k, cache_write_price_per_1k, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET
      prompt_price_per_1k = excluded.prompt_price_per_1k,
      completion_price_per_1k = excluded.completion_price_per_1k,
      cache_read_price_per_1k = excluded.cache_read_price_per_1k,
      cache_write_price_per_1k = excluded.cache_write_price_per_1k,
      updated_at = excluded.updated_at
  `)
  stmt.run(
    model,
    pricing.promptPricePer1k,
    pricing.completionPricePer1k,
    pricing.cacheReadPricePer1k ?? 0,
    pricing.cacheWritePricePer1k ?? 0,
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
  }
}

export function getAllModelPricing(db: Database): Array<{
  model: string
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k: number
  cacheWritePricePer1k: number
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
    updated_at: number
  }>

  return rows.map((row) => ({
    model: row.model,
    promptPricePer1k: row.prompt_price_per_1k,
    completionPricePer1k: row.completion_price_per_1k,
    cacheReadPricePer1k: row.cache_read_price_per_1k,
    cacheWritePricePer1k: row.cache_write_price_per_1k,
    updatedAt: row.updated_at,
  }))
}
