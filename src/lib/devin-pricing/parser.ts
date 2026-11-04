import type { ModelPricingPer1k } from "~/lib/models-dev/types"
import { asRecord, asString } from "~/lib/json-shape"

type DevinPrices = Map<string, ModelPricingPer1k>

export function parseDevinPrices(document: string): DevinPrices {
  return parseDevinCatalog(document).prices
}

export function parseDevinCatalog(document: string): {
  prices: DevinPrices
  swe2FreeUntil?: number
} {
  const source = modelCostSource(document)
  // Parse only the JSON array; never evaluate the surrounding MDX document.
  const match = /\bconst\s+modelCostData\s*=\s*(\[[\s\S]*?\])\s*;/.exec(source)
  if (!match) throw new Error("Missing Devin modelCostData")
  const json = match[1].replace(
    /"(?:[^"\\]|\\.)*"|`([^`\\]*)`|([:[,]\s*)(-?\.\d+)/g,
    (
      value: string,
      template: string | undefined,
      prefix: string | undefined,
      number: string | undefined,
    ) => {
      if (template !== undefined) {
        if (template.includes("${"))
          throw new Error("Dynamic Devin price literal")
        return JSON.stringify(template)
      }
      return prefix !== undefined && number !== undefined ?
          prefix + number.replace(".", "0.")
        : value
    },
  )
  const promotion =
    /SWE-2 is free for self-serve[^;\n]{0,300}through ([A-Za-z]+ \d{1,2}, \d{4})/i.exec(
      source,
    )
  const end =
    promotion ? Date.parse(`${promotion[1]} 00:00:00 GMT`) + 86_400_000 : NaN
  return {
    prices: buildDevinPrices(JSON.parse(json)),
    swe2FreeUntil: Number.isFinite(end) ? end : undefined,
  }
}

function modelCostSource(document: string): string {
  const manifest =
    /<template\s+data-mint="manifest">([\s\S]*?)<\/template>/.exec(document)
  if (!manifest) return document
  const root = asRecord(JSON.parse(manifest[1]))
  const page = asRecord(root?.page)
  const mdx = asRecord(page?.mdx)
  const source = asRecord(mdx?.mdxSource)
  return asString(source?.compiledSource) ?? ""
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
