import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "codex-native",
  oauth: true,
  descriptor: {
    id: "codex",
    presentation: {
      category: "popular",
      badgeKey: "accounts.badge.oauth",
      manualOAuthCallback: true,
    },
    name: "Codex",
    icon: "terminal",
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
