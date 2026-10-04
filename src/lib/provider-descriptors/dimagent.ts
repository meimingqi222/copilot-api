import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "dimagent-native",
  oauth: true,
  descriptor: {
    id: "dimagent",
    presentation: {
      category: "domestic",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.dimagent.deviceHint",
    },
    name: "DimAgent",
    icon: "dimagent",
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery"],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})
