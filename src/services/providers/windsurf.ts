import { createWindsurfChatCompletions } from "~/services/windsurf/create-chat-completions"
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
    try {
      const models = await getWindsurfModelsForAccount(account)
      account.availableModels = models
      return models
    } catch {
      const defaults = fallbackWindsurfModels("swe-1-6-fast")
      account.availableModels = defaults
      return defaults
    }
  },
  createChatCompletions(account, payload, signal, ctx) {
    return createWindsurfChatCompletions({ account, payload, signal, ctx })
  },
}
