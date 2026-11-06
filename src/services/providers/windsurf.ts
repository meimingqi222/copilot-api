import { getProviderDescriptor } from "~/lib/provider-descriptors"
import {
  applyWindsurfQuotaSnapshot,
  fetchWindsurfQuota,
} from "~/lib/quota/fetchers/windsurf"
import { refreshProviderQuota } from "~/lib/quota/refresh"
import {
  fallbackWindsurfConnectionModelsForConnection,
  getWindsurfModelsForConnection,
} from "~/services/windsurf/get-models"

import type { ProviderRuntime } from "~/services/providers/runtime"

export const windsurfProviderRuntime: ProviderRuntime = {
  id: "windsurf",
  descriptor: getProviderDescriptor("windsurf"),
  quota: { source: "poll" },
  supports(_connection, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(connection) {
    const models = await getWindsurfModelsForConnection(connection)
    return models
  },
  async refreshQuota(connection, signal, options) {
    return refreshProviderQuota(connection, fetchWindsurfQuota, signal, {
      ...options,
      applySnapshot: applyWindsurfQuotaSnapshot,
    })
  },
  getFallbackModels(connection) {
    return fallbackWindsurfConnectionModelsForConnection(connection)
  },
}
