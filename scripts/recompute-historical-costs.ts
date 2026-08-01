#!/usr/bin/env bun
/**
 * Recompute the `cost` column of every row in `usage_stats` using the
 * current pricing (models.dev cache + builtin default-prices + DB overrides).
 *
 * Use this after correcting model prices to bring historical totals in line
 * with the new pricing. The script prints a per-model summary of the changes
 * and asks for confirmation via the --apply flag before writing.
 *
 * Usage:
 *   bun run scripts/recompute-historical-costs.ts          # dry-run
 *   bun run scripts/recompute-historical-costs.ts --apply  # write changes
 */
import { Database } from "bun:sqlite"

import { PATHS } from "~/lib/paths"
import { isProviderId } from "~/lib/provider-config"
import { statsStore } from "~/lib/stats-store"

const apply = process.argv.includes("--apply")

statsStore.init()
const db = new Database(PATHS.STATS_PATH)

type Row = {
  id: number
  model: string
  provider: string | null
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost: number
}

const rows = db
  .prepare(
    `SELECT id, model, provider, prompt_tokens, completion_tokens,
            cache_read_tokens, cache_write_tokens, cost
       FROM usage_stats`,
  )
  .all() as Array<Row>

const summary: Record<
  string,
  { rows: number; oldCost: number; newCost: number }
> = {}

const updates: Array<{ id: number; cost: number }> = []
const pricingCache = new Map<
  string,
  ReturnType<typeof statsStore.getModelPricing>
>()

for (const row of rows) {
  // Key pricing lookups by model+provider: the same model id can be served
  // by different providers with different models.dev pricing buckets.
  const cacheKey = `${row.model}\u0000${row.provider ?? ""}`
  if (!pricingCache.has(cacheKey)) {
    pricingCache.set(
      cacheKey,
      statsStore.getModelPricing(
        row.model,
        row.provider && isProviderId(row.provider) ? row.provider : undefined,
      ),
    )
  }
  const pricing = pricingCache.get(cacheKey)
  const newCost =
    pricing ?
      (row.prompt_tokens / 1000) * pricing.promptPricePer1k
      + (row.completion_tokens / 1000) * pricing.completionPricePer1k
      + (row.cache_read_tokens / 1000) * pricing.cacheReadPricePer1k
      + (row.cache_write_tokens / 1000) * pricing.cacheWritePricePer1k
    : 0

  const bucket = (summary[row.model] ??= {
    rows: 0,
    oldCost: 0,
    newCost: 0,
  })
  bucket.rows += 1
  bucket.oldCost += row.cost
  bucket.newCost += newCost

  if (Math.abs(newCost - row.cost) > 1e-9) {
    updates.push({ id: row.id, cost: newCost })
  }
}

console.log(`Scanned ${rows.length} rows; ${updates.length} need updating.\n`)
console.log("Per-model summary (cost in USD):")
console.log(
  ["model", "rows", "old_cost", "new_cost", "delta"]
    .map((s) => s.padEnd(24))
    .join(""),
)
console.log("-".repeat(120))
for (const [model, s] of Object.entries(summary).sort(
  ([, a], [, b]) => b.newCost - a.newCost,
)) {
  console.log(
    [
      model,
      String(s.rows),
      s.oldCost.toFixed(4),
      s.newCost.toFixed(4),
      (s.newCost - s.oldCost).toFixed(4),
    ]
      .map((v) => v.padEnd(24))
      .join(""),
  )
}

if (!apply) {
  console.log(
    `\nDry-run only. Re-run with --apply to write the ${updates.length} updates.`,
  )
  process.exit(0)
}

const stmt = db.prepare(`UPDATE usage_stats SET cost = ? WHERE id = ?`)
const tx = db.transaction((items: Array<{ id: number; cost: number }>) => {
  for (const item of items) stmt.run(item.cost, item.id)
})
tx(updates)
console.log(`\n✅ Applied ${updates.length} cost updates.`)
