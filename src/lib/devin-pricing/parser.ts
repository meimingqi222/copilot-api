import type { ModelPricingPer1k } from "~/lib/models-dev/types"

type DevinPrices = Map<string, ModelPricingPer1k>

export function parseDevinPrices(document: string): DevinPrices {
  // Parse only the JSON array; never evaluate the surrounding MDX document.
  const match = /export\s+const\s+modelCostData\s*=\s*(\[[\s\S]*?\])\s*;/.exec(
    document,
  )
  if (!match) throw new Error("Missing Devin modelCostData")
  return buildDevinPrices(JSON.parse(match[1]))
}

export function buildDevinPrices(rows: unknown): DevinPrices {
  if (!Array.isArray(rows)) throw new Error("Invalid Devin modelCostData")
  const prices: DevinPrices = new Map()
  for (const row of rows as Array<Record<string, unknown>>) {
    if (row?.tier !== "TEAMS_TIER_PRO") continue
    const id =
      typeof row.model_uid === "string" ?
        row.model_uid.trim().toLowerCase()
      : ""
    const rates = [
      row.input_cost_per_million_usd,
      row.output_cost_per_million_usd,
      row.cache_read_cost_per_million_usd,
      row.cache_write_cost_per_million_usd,
    ]
    if (
      !id
      || prices.has(id)
      || rates.some(
        (rate) =>
          typeof rate !== "number" || !Number.isFinite(rate) || rate < 0,
      )
    ) {
      throw new Error("Invalid or duplicate Devin Pro price")
    }
    const [input, output, cacheRead, cacheWrite] = rates as Array<number>
    prices.set(id, {
      promptPricePer1k: input / 1000,
      completionPricePer1k: output / 1000,
      cacheReadPricePer1k: cacheRead / 1000,
      cacheWritePricePer1k: cacheWrite / 1000,
      contextTierAbove: null,
    })
  }
  if (prices.size === 0) throw new Error("No Devin Pro prices")
  return prices
}
