import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import {
  refreshCopilotTokenForConnection,
  refreshQuotaForConnection,
} from "~/lib/account-store"
import {
  getConnectionCopilotToken,
  getConnectionProvider,
  setConnectionModels,
} from "~/lib/provider-connections"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { getModelsForConnection } from "~/services/copilot/get-models"

import type { ProviderRuntime } from "./runtime"

function toModelMappings(connection: ProviderConnection): Array<ModelMapping> {
  return connection.models ?? []
}

export const copilotProviderRuntime: ProviderRuntime = {
  id: "copilot",
  descriptor: {
    id: "copilot",
    name: "Copilot",
    icon: "github",
    authMode: "device_flow",
    features: [
      "quota",
      "cooldown",
      "native_responses",
      "native_messages",
      "embeddings",
      "device_flow",
      "model_discovery",
    ],
    accountFields: [],
  },
  supports(_connection, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(connection) {
    if (getConnectionProvider(connection) !== "copilot") {
      return []
    }
    if (!getConnectionCopilotToken(connection)) {
      return toModelMappings(connection)
    }
    const models = await getModelsForConnection(connection)
    const seen = new Set<string>()
    const mappings: Array<ModelMapping> = models.data
      .filter((model) => {
        if (model.policy?.state !== "enabled") return false
        if (seen.has(model.id)) return false
        seen.add(model.id)
        return true
      })
      .map((model) => ({
        publicId: canonicalNativeModelId(model.id),
        upstreamId: model.id,
        name: model.name,
        vendor: model.vendor,
        enabled: true,
        pickerEnabled: model.model_picker_enabled,
        pickerCategory: model.model_picker_category,
        endpoints: toModelEndpoints(model.supported_endpoints ?? []),
      }))
    setConnectionModels(connection, mappings)
    return mappings
  },
  async refreshQuota(connection) {
    return refreshQuotaForConnection(connection)
  },
  async refreshAuth(connection) {
    await refreshCopilotTokenForConnection(connection)
  },
}

function toModelEndpoints(
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
