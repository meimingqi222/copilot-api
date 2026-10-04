import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "kimi-native",
  oauth: true,
  descriptor: {
    id: "kimi",
    presentation: {
      category: "domestic",
      badgeKey: "accounts.badge.oauth",
    },
    name: "Kimi",
    icon: "moon",
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery", "device_flow"],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})
