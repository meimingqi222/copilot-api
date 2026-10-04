import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "commandcode-native",
  oauth: true,
  planBased: true,
  descriptor: {
    id: "commandcode-plan",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.commandcode-plan.deviceHint",
    },
    name: "Command Code Plan",
    icon: "commandcode",
    authMode: "oauth",
    features: [
      "quota",
      "cooldown",
      "native_messages",
      "native_responses",
      "oauth",
      "model_discovery",
    ],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})
