import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "meoo-native",
  oauth: true,
  credentials: {
    primaryKey: "accessToken",
    contextStringKeys: ["serviceAk", "projectUrlId", "scope"],
    defaultBaseUrl: "https://api.meoo.host/meoo-ai/compatible-mode/v1",
  },
  descriptor: {
    id: "meoo",
    name: "Meoo Project Gateway",
    icon: "bot",
    authMode: "oauth",
    presentation: {
      category: "domestic",
      badgeKey: "accounts.badge.multi",
      hasManualMode: true,
      importMethod: "pat",
      manualOAuthCallback: true,
    },
    features: ["quota", "cooldown", "oauth", "model_discovery"],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})
