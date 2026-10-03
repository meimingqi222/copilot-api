import type { AccountModel, ModelMapping } from "~/lib/provider-connections"

export function accountModelsToMappings(
  models: Array<AccountModel>,
): Array<ModelMapping> {
  return models.map((m) => ({
    publicId: m.id,
    upstreamId: m.upstreamId || m.id,
    name: m.name,
    vendor: m.vendor,
    enabled: true,
    pickerEnabled: m.pickerEnabled,
    pickerCategory: m.pickerCategory,
    endpoints: accountModelEndpointsToMappingEndpoints(m.supportedEndpoints),
  }))
}

function accountModelEndpointsToMappingEndpoints(
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
