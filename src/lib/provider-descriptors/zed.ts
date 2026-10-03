import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "zed-native",
  oauth: true,
  descriptor: {
    id: "zed",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.zed.deviceHint",
    },
    name: "Zed",
    icon: "zed",
    authMode: "oauth",
    features: ["cooldown", "native_messages", "oauth", "model_discovery"],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})

export const descriptor = providerMetadata.descriptor
