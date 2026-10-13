import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import {
  resolveModelsDevPriceDetailed,
  setModelsDevCatalogForTest,
  type ModelsDevCatalog,
} from "~/lib/models-dev"

const file = process.argv[2]
if (!file)
  throw new Error(
    "Usage: bun run scripts/maintenance/audit-pricing-catalog.ts <catalog.json>",
  )
const text = readFileSync(file, "utf8")
const catalog = JSON.parse(text) as ModelsDevCatalog
setModelsDevCatalogForTest(catalog)
let quotes = 0
let tiers = 0
const errors: Array<string> = []
for (const [provider, data] of Object.entries(catalog)) {
  for (const [model, entry] of Object.entries(data.models)) {
    const cost = entry.cost
    if (!cost) continue
    quotes++
    const quote = resolveModelsDevPriceDetailed(`${provider}/${model}`)
    const expected = [
      cost.input,
      cost.output,
      cost.cache_read ?? cost.input,
      cost.cache_write ?? cost.input,
    ].map((rate) => rate / 1000)
    const actual = quote && [
      quote.promptPricePer1k,
      quote.completionPricePer1k,
      quote.cacheReadPricePer1k,
      quote.cacheWritePricePer1k,
    ]
    if (!actual || actual.some((rate, i) => rate !== expected[i]))
      errors.push(`${provider}/${model}: base quote mismatch`)
    for (const tier of cost.tiers ?? []) {
      if (tier.tier.type !== "context") continue
      tiers++
      const rate = (quote?.contextTiers ?? []).find(
        (t) => t.thresholdTokens === tier.tier.size,
      )
      const expectedTier = [
        tier.input ?? cost.input,
        tier.output ?? cost.output,
        tier.cache_read ?? cost.cache_read ?? tier.input ?? cost.input,
        tier.cache_write ?? cost.cache_write ?? tier.input ?? cost.input,
      ].map((r) => r / 1000)
      // Redundant base-priced tiers can be omitted if there is no repricing.
      if (!rate && expectedTier.every((r, i) => r === expected[i])) continue
      const actualTier = rate && [
        rate.promptPricePer1k,
        rate.completionPricePer1k,
        rate.cacheReadPricePer1k,
        rate.cacheWritePricePer1k,
      ]
      if (!actualTier || actualTier.some((r, i) => r !== expectedTier[i]))
        errors.push(`${provider}/${model}: tier ${tier.tier.size} mismatch`)
    }
  }
}
console.log(
  JSON.stringify(
    {
      sha256: createHash("sha256").update(text).digest("hex"),
      providers: Object.keys(catalog).length,
      quotes,
      tiers,
      mismatches: errors.length,
      errors: errors.slice(0, 20),
    },
    null,
    2,
  ),
)
setModelsDevCatalogForTest(null)
if (errors.length) process.exitCode = 1
