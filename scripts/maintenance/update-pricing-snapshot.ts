import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import type { ModelsDevCatalog } from "~/lib/models-dev/types"
import {
  GLOBAL_MODEL_PROVIDER_PRIORITY,
  MODELS_DEV_API_URL,
  MODELS_DEV_PROVIDER_PRIORITY,
} from "~/lib/models-dev/provider-map"

const file = process.argv[2]
if (!file)
  throw new Error(
    "Usage: bun run scripts/maintenance/update-pricing-snapshot.ts <catalog.json>",
  )
const text = readFileSync(file, "utf8")
const full = JSON.parse(text) as ModelsDevCatalog
const selected = new Set<string>([
  ...GLOBAL_MODEL_PROVIDER_PRIORITY,
  ...Object.values(MODELS_DEV_PROVIDER_PRIORITY).flat(),
  "windsurf",
])
const catalog: ModelsDevCatalog = {}
for (const provider of [...selected].sort()) {
  const data = full[provider]
  if (!data) continue
  catalog[provider] = {
    id: provider,
    ...(data.api && { api: data.api }),
    models: {},
  }
  for (const [model, entry] of Object.entries(data.models)) {
    catalog[provider].models[model] = {
      id: entry.id,
      ...(entry.cost && { cost: entry.cost }),
    }
  }
}
writeFileSync(
  "src/lib/models-dev/snapshot.json",
  JSON.stringify(
    {
      source: process.argv[3] ?? MODELS_DEV_API_URL,
      asOf: process.argv[4] ?? new Date().toISOString().slice(0, 10),
      sha256: createHash("sha256").update(text).digest("hex"),
      catalog,
    },
    null,
    2,
  ) + "\n",
)
console.log(`Saved ${Object.keys(catalog).length} scoped fallback providers`)
