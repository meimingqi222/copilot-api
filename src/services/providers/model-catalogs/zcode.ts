import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

const ZCODE_CATALOG: Array<CatalogEntry> = [
  ["GLM-5.3", "GLM-5.3"],
  ["GLM-5.3-Flash", "GLM-5.3-Flash"],
  ["GLM-5.2", "GLM-5.2"],
  ["GLM-5-Turbo", "GLM-5-Turbo"],
].map(([id, name]) => ({
  id,
  name,
  vendor: "zhipu",
  supportedEndpoints: ["/v1/messages"],
}))

export function getZcodeFallbackModels(): Array<ModelMapping> {
  return toModelMappings(ZCODE_CATALOG)
}
