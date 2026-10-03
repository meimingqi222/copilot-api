import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "xai-native",
  oauth: true,
  descriptor: {
    id: "xai",
    presentation: {
      category: "popular",
      badgeKey: "accounts.badge.oauth",
      manualOAuthCallback: true,
    },
    name: "xAI",
    icon: "zap",
    authMode: "oauth",
    features: [
      "quota",
      "cooldown",
      "native_responses",
      "oauth",
      "model_discovery",
    ],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})

export const descriptor = providerMetadata.descriptor
