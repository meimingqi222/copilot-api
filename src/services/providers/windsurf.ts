import {
  getMutableProviderConnection,
  persistProviderConnections,
} from "~/lib/provider-connections"
import { refreshWindsurfQuota } from "~/lib/quota/fetchers/windsurf"
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
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery"],
    // Devin/Windsurf sign-in is the primary path (PKCE OAuth against
    // app.devin.ai). The provider deliberately stays out of
    // `OAUTH_PROVIDER_IDS` (see `provider-strategies.ts`) so legacy
    // direct-token classification is untouched; a session token can still be
    // pasted through the OAuth flow's manual completion.
    accountFields: [
      {
        key: "proxyUrl",
        type: "url",
        labelKey: "accounts.oauth.fields.proxyUrl",
        descriptionKey: "accounts.oauth.fields.proxyUrlHint",
        placeholder: "http://127.0.0.1:7890",
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
