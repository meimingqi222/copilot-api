import { getProviderDescriptor } from "~/lib/provider-descriptors"
import {
  getMutableProviderConnection,
  persistProviderConnections,
} from "~/lib/provider-connections"
import { refreshWindsurfQuota } from "~/lib/quota/fetchers/windsurf"
import {
  fallbackWindsurfConnectionModelsForConnection,
  getWindsurfModelsForConnection,
} from "~/services/windsurf/get-models"

import type { ProviderRuntime } from "~/services/providers/runtime"

export const windsurfProviderRuntime: ProviderRuntime = {
  id: "windsurf",
  descriptor: getProviderDescriptor("windsurf"),
  supports(_connection, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(connection) {
    const models = await getWindsurfModelsForConnection(connection)
    return models
  },
  async refreshQuota(connection, signal) {
    const liveConnection = getMutableProviderConnection(connection.id)
    if (!liveConnection) return undefined
    const snapshot = await refreshWindsurfQuota(liveConnection, signal)
    await persistProviderConnections()
    return snapshot
  },
  getFallbackModels(connection) {
    return fallbackWindsurfConnectionModelsForConnection(connection)
  },
}
