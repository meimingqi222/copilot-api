import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

const ANTIGRAVITY_CATALOG: Array<CatalogEntry> = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    vendor: "antigravity",
    supportedEndpoints: ["/chat/completions", "/v1/messages"],
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    vendor: "antigravity",
    supportedEndpoints: ["/chat/completions", "/v1/messages"],
  },
  {
    id: "gemini-pro-agent",
    name: "Gemini 3.1 Pro (High)",
    vendor: "antigravity",
    supportedEndpoints: ["/chat/completions", "/v1/messages"],
  },
]

export function getAntigravityFallbackModels(): Array<ModelMapping> {
  return toModelMappings(ANTIGRAVITY_CATALOG)
}
