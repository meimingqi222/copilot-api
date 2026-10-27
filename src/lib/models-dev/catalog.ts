import type {
  ContextTierPricingPer1k,
  ModelPricingPer1k,
  ModelsDevCatalog,
  ModelsDevCost,
  ModelsDevModel,
} from "~/lib/models-dev/types"

export interface ModelsDevPriceIndexes {
  byProviderModel: Map<string, ModelPricingPer1k>
  byModelId: Map<
    string,
    Array<{ provider: string; pricing: ModelPricingPer1k }>
  >
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function extractContextTiers(
  cost: ModelsDevCost,
): Array<ContextTierPricingPer1k> {
  const contextTiers = (cost.tiers ?? [])
    .filter(
      (t) =>
        t?.tier?.type === "context"
        && Number.isFinite(t.tier.size)
        && t.tier.size > 0
        && [t.input, t.output, t.cache_read, t.cache_write].every(
          (rate) => rate === undefined || validRate(rate),
        ),
    )
    .sort((a, b) => a.tier.size - b.tier.size)
  if (contextTiers.length > 0) {
    return contextTiers.map((t) => ({
      thresholdTokens: t.tier.size,
      promptPricePer1k: (t.input ?? cost.input) / 1000,
      completionPricePer1k: (t.output ?? cost.output) / 1000,
      cacheReadPricePer1k:
        (t.cache_read ?? cost.cache_read ?? t.input ?? cost.input) / 1000,
      cacheWritePricePer1k:
        (t.cache_write ?? cost.cache_write ?? t.input ?? cost.input) / 1000,
    }))
  }
  if (cost.context_over_200k) {
    const t = cost.context_over_200k
    return [
      {
        thresholdTokens: 200_000,
        promptPricePer1k: (t.input ?? cost.input) / 1000,
        completionPricePer1k: (t.output ?? cost.output) / 1000,
        cacheReadPricePer1k:
          (t.cache_read ?? cost.cache_read ?? t.input ?? cost.input) / 1000,
        cacheWritePricePer1k:
          (t.cache_write ?? cost.cache_write ?? t.input ?? cost.input) / 1000,
      },
    ]
  }
  return []
}

function costToPer1k(cost: ModelsDevCost): ModelPricingPer1k {
  const tiers = extractContextTiers(cost)
  const base = {
    promptPricePer1k: cost.input / 1000,
    completionPricePer1k: cost.output / 1000,
    cacheReadPricePer1k: (cost.cache_read ?? cost.input) / 1000,
    cacheWritePricePer1k: (cost.cache_write ?? cost.input) / 1000,
  }
  // 跳过与基础价完全相同的“假分档”（部分网关条目会原样回填）。
  if (
    tiers.every(
      (tier) =>
        tier.promptPricePer1k === base.promptPricePer1k
        && tier.completionPricePer1k === base.completionPricePer1k
        && tier.cacheReadPricePer1k === base.cacheReadPricePer1k
        && tier.cacheWritePricePer1k === base.cacheWritePricePer1k,
    )
  ) {
    return { ...base, contextTierAbove: null }
  }
  return {
    ...base,
    contextTierAbove: tiers[0] ?? null,
    contextTiers: tiers,
  }
}

function collectModelCosts(
  providerId: string,
  modelKey: string,
  model: ModelsDevModel,
  indexes: ModelsDevPriceIndexes,
): void {
  if (
    !model.cost
    || ![model.cost.input, model.cost.output].every(validRate)
    || [model.cost.cache_read, model.cost.cache_write].some(
      (rate) => rate !== undefined && !validRate(rate),
    )
  ) {
    return
  }
  const pricing = costToPer1k(model.cost)
  const key = modelKey.trim().toLowerCase()
  indexes.byProviderModel.set(`${providerId}/${key}`, pricing)
  const existing = indexes.byModelId.get(key) ?? []
  existing.push({ provider: providerId, pricing })
  indexes.byModelId.set(key, existing)
}

export function buildModelsDevPriceIndexes(
  catalog: ModelsDevCatalog,
): ModelsDevPriceIndexes {
  const indexes: ModelsDevPriceIndexes = {
    byProviderModel: new Map(),
    byModelId: new Map(),
  }

  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelKey, model] of Object.entries(provider.models)) {
      collectModelCosts(providerId, modelKey, model, indexes)
    }
  }

  const aliases = new Map<string, Array<ModelPricingPer1k>>()
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const pricing = indexes.byProviderModel.get(
        `${providerId}/${modelKey.toLowerCase()}`,
      )
      if (!pricing) continue
      const native = (model.id || modelKey).trim().toLowerCase()
      const keys = new Set([native, native.split("/").at(-1)!])
      for (const alias of keys) {
        const key = `${providerId}/${alias}`
        const entries = aliases.get(key) ?? []
        entries.push(pricing)
        aliases.set(key, entries)
      }
    }
  }
  for (const [key, entries] of aliases) {
    const slashIndex = key.indexOf("/")
    const providerModels = catalog[key.slice(0, slashIndex)]?.models
    if (
      indexes.byProviderModel.has(key)
      || (providerModels
        && Object.hasOwn(providerModels, key.slice(slashIndex + 1)))
    )
      continue
    if (
      !entries.every(
        (entry) => JSON.stringify(entry) === JSON.stringify(entries[0]),
      )
    )
      continue
    const pricing = entries[0]!
    indexes.byProviderModel.set(key, pricing)
    const slash = key.indexOf("/")
    const model = key.slice(slash + 1)
    const global = indexes.byModelId.get(model) ?? []
    global.push({ provider: key.slice(0, slash), pricing })
    indexes.byModelId.set(model, global)
  }

  return indexes
}

export function lookupProviderModelPrice(
  indexes: ModelsDevPriceIndexes,
  providerIds: Array<string>,
  modelId: string,
): ModelPricingPer1k | null {
  const normalized = modelId.trim().toLowerCase()
  for (const providerId of providerIds) {
    const direct = indexes.byProviderModel.get(`${providerId}/${normalized}`)
    if (direct) {
      return direct
    }
  }
  return null
}

function modelAuthorProvider(model: string): string | undefined {
  if (model.startsWith("claude-")) return "anthropic"
  if (/^(gpt-|o[134](?:-|$)|text-embedding-)/.test(model)) return "openai"
  if (model.startsWith("gemini-")) return "google"
  if (model.startsWith("grok-")) return "xai"
  return undefined
}

export function lookupGlobalModelPrice(
  indexes: ModelsDevPriceIndexes,
  modelId: string,
): ModelPricingPer1k | null {
  const normalized = modelId.trim().toLowerCase()
  const entries = indexes.byModelId.get(normalized)
  if (!entries || entries.length === 0) {
    return null
  }
  // Bare author IDs use the author's quote. Unrecognized names must agree
  // across channels; catalog insertion order is not a billing policy.
  const owner = modelAuthorProvider(normalized)
  const official = entries.find((entry) => entry.provider === owner)
  if (official) return official.pricing
  const first = entries[0]!.pricing
  return (
      entries.every(
        (entry) => JSON.stringify(entry.pricing) === JSON.stringify(first),
      )
    ) ?
      first
    : null
}

// ── Context windows ───────────────────────────────────────────────
//
// models.dev also names each model's context window (`limit.context`), which is
// what a model picker shows as a "1M" / "200k" badge. It is indexed the same way
// the prices are, so a connection whose upstream `/models` response carries no
// window still gets one from the catalog.

export interface ModelsDevContextIndexes {
  /** `${providerId}/${modelKey}` → context tokens. */
  byProviderModel: Map<string, number>
  /** model key → context tokens, best provider first. */
  byModelId: Map<string, Array<{ provider: string; context: number }>>
}

function collectModelContext(
  providerId: string,
  modelKey: string,
  model: ModelsDevModel,
  indexes: ModelsDevContextIndexes,
): void {
  const context = model.limit?.context
  if (
    typeof context !== "number"
    || !Number.isFinite(context)
    || context <= 0
  ) {
    return
  }
  const nativeId = (model.id || modelKey).trim().toLowerCase()
  const slashParts = nativeId.includes("/") ? nativeId.split("/") : []
  const tailId = slashParts.at(-1) ?? nativeId
  const keys = new Set<string>([
    nativeId,
    modelKey.trim().toLowerCase(),
    tailId,
  ])
  for (const key of keys) {
    indexes.byProviderModel.set(`${providerId}/${key}`, context)
    const existing = indexes.byModelId.get(key) ?? []
    if (!existing.some((entry) => entry.provider === providerId)) {
      existing.push({ provider: providerId, context })
      indexes.byModelId.set(key, existing)
    }
  }
}

export function buildModelsDevContextIndexes(
  catalog: ModelsDevCatalog,
): ModelsDevContextIndexes {
  const indexes: ModelsDevContextIndexes = {
    byProviderModel: new Map(),
    byModelId: new Map(),
  }
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelKey, model] of Object.entries(provider.models)) {
      collectModelContext(providerId, modelKey, model, indexes)
    }
  }
  return indexes
}

export function lookupProviderModelContext(
  indexes: ModelsDevContextIndexes,
  providerIds: Array<string>,
  modelId: string,
): number | undefined {
  const normalized = modelId.trim().toLowerCase()
  for (const providerId of providerIds) {
    const hit = indexes.byProviderModel.get(`${providerId}/${normalized}`)
    if (hit !== undefined) return hit
  }
  return undefined
}

export function lookupGlobalModelContext(
  indexes: ModelsDevContextIndexes,
  modelId: string,
): number | undefined {
  const normalized = modelId.trim().toLowerCase()
  return indexes.byModelId.get(normalized)?.[0]?.context
}

// ── Reasoning efforts ─────────────────────────────────────────────
//
// models.dev also names the reasoning levels each model takes (v1:
// `reasoning_options: [{ type: "effort", values: [...] }]`, v2:
// `capabilities.reasoning.effort`). Indexed like the context window: per
// provider+model for a provider hint, and per bare id as the level set most
// providers give it — the consensus magpie's `mostListed` picks.

export interface ModelsDevEffortsIndexes {
  /** `${providerId}/${modelKey}` → levels. */
  byProviderModel: Map<string, Array<string>>
  /** model key → the levels most providers listing any give. */
  byModelId: Map<string, Array<string>>
}

function collectEfforts(model: ModelsDevModel): Array<string> | undefined {
  const v2 = model.capabilities?.reasoning?.effort
  const v1 = model.reasoning_options?.find(
    (option) => option.type === "effort",
  )?.values
  const values = v2 && v2.length > 0 ? v2 : v1
  if (!values) return undefined
  const levels: Array<string> = []
  for (const value of values) {
    if (typeof value !== "string") continue
    const level = value.trim()
    // v2 spells the provider's own default as a value; it is not a level.
    if (!level || level === "default" || levels.includes(level)) continue
    levels.push(level)
  }
  return levels.length > 0 ? levels : undefined
}

/** 投票次数最多的一组档位；平票取更短、再按字典序，保证跨进程稳定。 */
function mostListedLevels(votes: Map<string, number>): string {
  const commas = (levels: string) => levels.match(/,/g)?.length ?? 0
  let best = ""
  let count = 0
  for (const [levels, c] of votes) {
    if (
      c > count
      || (c === count
        && (commas(levels) < commas(best)
          || (commas(levels) === commas(best) && levels < best)))
    ) {
      best = levels
      count = c
    }
  }
  return best
}

export function buildModelsDevEffortsIndexes(
  catalog: ModelsDevCatalog,
): ModelsDevEffortsIndexes {
  const indexes: ModelsDevEffortsIndexes = {
    byProviderModel: new Map(),
    byModelId: new Map(),
  }
  const votes = new Map<string, Map<string, number>>()

  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const levels = collectEfforts(model)
      if (!levels) continue
      const nativeId = (model.id || modelKey).trim().toLowerCase()
      const tailId =
        nativeId.includes("/") ? nativeId.split("/").at(-1)! : nativeId
      const keys = new Set([nativeId, modelKey.trim().toLowerCase(), tailId])
      const joined = levels.join(",")
      for (const key of keys) {
        indexes.byProviderModel.set(`${providerId}/${key}`, levels)
        const byLevels = votes.get(key) ?? new Map<string, number>()
        byLevels.set(joined, (byLevels.get(joined) ?? 0) + 1)
        votes.set(key, byLevels)
      }
    }
  }

  for (const [key, byLevels] of votes) {
    const best = mostListedLevels(byLevels)
    if (best) indexes.byModelId.set(key, best.split(","))
  }
  return indexes
}

export function lookupProviderModelEfforts(
  indexes: ModelsDevEffortsIndexes,
  providerIds: Array<string>,
  modelId: string,
): Array<string> | undefined {
  const normalized = modelId.trim().toLowerCase()
  for (const providerId of providerIds) {
    const hit = indexes.byProviderModel.get(`${providerId}/${normalized}`)
    if (hit) return hit
  }
  return undefined
}

export function lookupGlobalModelEfforts(
  indexes: ModelsDevEffortsIndexes,
  modelId: string,
): Array<string> | undefined {
  return indexes.byModelId.get(modelId.trim().toLowerCase())
}
