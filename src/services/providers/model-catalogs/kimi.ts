import type { ModelMapping } from "~/lib/provider-connections"
import { KIMI_CODING_MODELS } from "~/lib/provider-presets/domestic-primary"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

/**
 * Kimi Code 的 OAuth 账号走 `/coding/v1/chat/completions`，模型 IDs 与
 * 预设里的 Kimi Coding 列表同源；实时发现不可用时用这一份，避免再维护
 * 一份会过期的 `kimi-k2` 旧表。
 */
const KIMI_CATALOG: Array<CatalogEntry> = KIMI_CODING_MODELS.map((model) => ({
  id: model.publicId,
  upstreamId: model.upstreamId,
  name: model.name ?? model.publicId,
  vendor: "moonshot",
  supportedEndpoints: ["/chat/completions"],
}))

export function getKimiFallbackModels(): Array<ModelMapping> {
  return toModelMappings(KIMI_CATALOG)
}
