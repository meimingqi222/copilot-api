import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"

export const providerMetadata = defineProviderMetadata({
  protocol: "qoder-native",
  oauth: true,
  descriptor: {
    id: "qoder",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.deviceFlow",
      hintKey: "accounts.provider.qoder.deviceHint",
    },
    name: "Qoder",
    icon: "qoder",
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery", "device_flow"],
    accountFields: [],
  },
})

export const descriptor = providerMetadata.descriptor
