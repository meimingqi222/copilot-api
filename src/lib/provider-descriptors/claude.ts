import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "claude-native",
  oauth: true,
  descriptor: {
    id: "claude",
    presentation: {
      category: "popular",
      badgeKey: "accounts.badge.oauth",
      manualOAuthCallback: true,
    },
    name: "Claude",
    icon: "sparkles",
    authMode: "oauth",
    features: [
      "quota",
      "cooldown",
      "native_messages",
      "oauth",
      "model_discovery",
    ],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})

export const descriptor = providerMetadata.descriptor
