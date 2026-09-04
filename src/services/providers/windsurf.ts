import {
  fallbackWindsurfConnectionModelsForConnection,
  getWindsurfModelsForConnection,
} from "~/services/windsurf/get-models"

import type { ProviderRuntime } from "./runtime"

export const windsurfProviderRuntime: ProviderRuntime = {
  id: "windsurf",
  descriptor: {
    id: "windsurf",
    name: "Windsurf",
    icon: "wind",
    authMode: "direct",
    features: ["cooldown", "model_discovery"],
    accountFields: [
      {
        key: "apiKey",
        type: "secret",
        labelKey: "accounts.provider.windsurf.fields.apiKey",
        required: true,
      },
    ],
  },
  supports(_connection, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(connection) {
    const models = await getWindsurfModelsForConnection(connection)
    return models
  },
  getFallbackModels(connection) {
    return fallbackWindsurfConnectionModelsForConnection(connection)
  },
}
