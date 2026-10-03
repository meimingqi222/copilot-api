import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "factory-native",
  oauth: true,
  descriptor: {
    id: "factory",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.factory.deviceHint",
    },
    name: "Factory",
    icon: "factory",
    authMode: "oauth",
    features: [
      "quota",
      "cooldown",
      "native_messages",
      "native_responses",
      "oauth",
      "model_discovery",
      "device_flow",
    ],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})

export const descriptor = providerMetadata.descriptor
