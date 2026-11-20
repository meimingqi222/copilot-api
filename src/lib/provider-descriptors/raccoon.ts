import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "raccoon-native",
  oauth: true,
  planBased: true,
  descriptor: {
    id: "raccoon",
    name: "SenseTime Raccoon (商汤小浣熊)",
    icon: "sparkles",
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery"],
    accountFields: OAUTH_ACCOUNT_FIELDS,
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.oauth",
      manualOAuthCallback: true,
    },
  },
})
