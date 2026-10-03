import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

const ZED_CATALOG: Array<CatalogEntry> = [
  ["claude-sonnet-4-6", "Claude 4.6 Sonnet"],
  ["claude-opus-4-6", "Claude 4.6 Opus"],
  ["claude-haiku-4-5-20251001", "Claude 4.5 Haiku"],
].map(([id, name]) => ({
  id,
  name,
  vendor: "anthropic",
  supportedEndpoints: ["/v1/messages"],
}))

export function getZedFallbackModels(): Array<ModelMapping> {
  return toModelMappings(ZED_CATALOG)
}
