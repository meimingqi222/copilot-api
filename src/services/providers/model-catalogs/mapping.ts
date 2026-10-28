import type { ModelMapping } from "~/lib/provider-connections"
import { endpointsFromSupported } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"

// ── ModelMapping 版本 ───────────────────────────────────────

export function toModelMappings(
  entries: Array<CatalogEntry>,
): Array<ModelMapping> {
  return entries.map((entry) => ({
    publicId: canonicalNativeModelId(entry.id),
    // upstreamId 是上线名，原样透传（大小写敏感，如 `MiniMax-M3`）；
    // 未显式指定时才退回公开句柄。
    upstreamId: entry.upstreamId ?? entry.id,
    name: entry.name,
    vendor: entry.vendor,
    enabled: true,
    pickerEnabled: entry.pickerEnabled ?? true,
    endpoints: endpointsFromSupported(entry.supportedEndpoints),
  }))
}
