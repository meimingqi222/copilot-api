import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"

// ── ModelMapping 版本 ───────────────────────────────────────

function endpointsToModelEndpoints(
  supported: Array<string>,
): Array<ModelMapping["endpoints"][number]> {
  const endpoints: Array<ModelMapping["endpoints"][number]> = []
  for (const ep of supported) {
    if (ep.includes("chat/completions")) endpoints.push("chat")
    else if (ep.includes("messages")) endpoints.push("messages")
    else if (ep.includes("responses")) endpoints.push("responses")
    else if (ep.includes("embeddings")) endpoints.push("embeddings")
    else if (ep.includes("images")) endpoints.push("images")
    else if (ep.includes("videos")) endpoints.push("videos")
  }
  if (endpoints.length === 0) endpoints.push("chat")
  return endpoints
}

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
    endpoints: endpointsToModelEndpoints(entry.supportedEndpoints),
  }))
}
