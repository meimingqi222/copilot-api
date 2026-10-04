import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "gemini-native",
  oauth: true,
  descriptor: {
    id: "gemini",
    presentation: {
      category: "popular",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.gemini.deviceHint",
    },
    name: "Gemini CLI",
    icon: "gemini",
    authMode: "oauth",
    features: ["cooldown", "oauth", "model_discovery"],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})
