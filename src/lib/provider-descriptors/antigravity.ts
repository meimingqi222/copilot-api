import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "antigravity-native",
  oauth: true,
  descriptor: {
    id: "antigravity",
    presentation: {
      category: "popular",
      badgeKey: "accounts.badge.oauth",
      manualOAuthCallback: true,
    },
    name: "Antigravity",
    icon: "orbit",
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery"],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})
