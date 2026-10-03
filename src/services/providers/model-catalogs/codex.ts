import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

// Fallback when Codex upstream /models is unavailable.
// Keep aligned with CPA codex-pro catalog (+ common image builtins).
const CODEX_CATALOG: Array<CatalogEntry> = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "codex-auto-review",
    name: "Codex Auto Review",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-image-1.5",
    name: "GPT Image 1.5",
    vendor: "openai",
    supportedEndpoints: ["/v1/images/generations"],
  },
  {
    id: "gpt-image-2",
    name: "GPT Image 2",
    vendor: "openai",
    supportedEndpoints: ["/v1/images/generations"],
  },
]

export function getCodexFallbackModels(): Array<ModelMapping> {
  return toModelMappings(CODEX_CATALOG)
}
