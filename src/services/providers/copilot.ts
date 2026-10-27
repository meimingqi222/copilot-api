import { getProviderDescriptor } from "~/lib/provider-descriptors"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import {
  endpointsFromSupported,
  getConnectionCopilotToken,
  getConnectionProvider,
  setConnectionModels,
} from "~/lib/provider-connections"
import { refreshQuotaForConnection } from "~/lib/quota/scheduler"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { refreshCopilotTokenForConnection } from "~/services/copilot/token-refresh"
import { getModelsForConnection } from "~/services/copilot/get-models"

import type { ProviderRuntime } from "~/services/providers/runtime"

/** 刷新失败/未登录时沿用的已存映射。 */
function storedMappings(connection: ProviderConnection): Array<ModelMapping> {
  return connection.models ?? []
}

export const copilotProviderRuntime: ProviderRuntime = {
  id: "copilot",
  descriptor: getProviderDescriptor("copilot"),
  supports(_connection, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(connection) {
    if (getConnectionProvider(connection) !== "copilot") {
      return []
    }
    if (!getConnectionCopilotToken(connection)) {
      return storedMappings(connection)
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
      .map((model) => {
        // Copilot lists the levels the model actually takes; the catalog
        // dropped them before, which left every Copilot model unable to say
        // which effort it accepts.
        const efforts = model.capabilities?.supports?.reasoning_effort
        return {
          publicId: canonicalNativeModelId(model.id),
          upstreamId: model.id,
          name: model.name,
          vendor: model.vendor,
          enabled: true,
          pickerEnabled: model.model_picker_enabled,
          pickerCategory: model.model_picker_category,
          endpoints: endpointsFromSupported(model.supported_endpoints ?? []),
          ...(efforts && efforts.length > 0 ? { efforts: [...efforts] } : {}),
        }
      })
    setConnectionModels(connection, mappings)
    return mappings
  },
  async refreshQuota(connection, signal) {
    return refreshQuotaForConnection(connection, false, signal)
  },
  async refreshAuth(connection) {
    await refreshCopilotTokenForConnection(connection)
  },
}
