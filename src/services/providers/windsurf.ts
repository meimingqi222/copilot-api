import { getWindsurfSettings } from "~/lib/accounts"
import { state } from "~/lib/state"
import {
  fallbackWindsurfModels,
  getWindsurfModelsForAccount,
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
  supports(_account, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(account) {
    const models = await getWindsurfModelsForAccount(account)
    account.availableModels = models
    return models
  },
  getFallbackModels(account) {
    const defaultModel =
      getWindsurfSettings(account)?.defaultModel
      ?? state.providerDefaults.windsurf.defaultModel
    return fallbackWindsurfModels(defaultModel)
  },
}
