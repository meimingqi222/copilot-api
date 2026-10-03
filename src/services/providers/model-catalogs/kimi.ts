import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

const KIMI_CATALOG: Array<CatalogEntry> = [
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    vendor: "moonshot",
    supportedEndpoints: ["/chat/completions"],
  },
  {
    id: "kimi-k2",
    name: "Kimi K2",
    vendor: "moonshot",
    supportedEndpoints: ["/chat/completions"],
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    vendor: "moonshot",
    supportedEndpoints: ["/chat/completions"],
  },
]

export function getKimiFallbackModels(): Array<ModelMapping> {
  return toModelMappings(KIMI_CATALOG)
}
