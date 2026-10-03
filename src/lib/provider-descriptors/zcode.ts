import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "zcode-native",
  oauth: true,
  descriptor: {
    id: "zcode",
    presentation: {
      category: "domestic",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.zcode.deviceHint",
    },
    name: "ZCode",
    icon: "zcode",
    authMode: "oauth",
    features: [
      "quota",
      "cooldown",
      "native_messages",
      "oauth",
      "model_discovery",
      "device_flow",
    ],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})

export const descriptor = providerMetadata.descriptor
