import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"

export const providerMetadata = defineProviderMetadata({
  protocol: "qoder-native",
  oauth: true,
  descriptor: {
    id: "qoder-cn",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.deviceFlow",
      hintKey: "accounts.provider.qoder-cn.deviceHint",
    },
    name: "Qoder CN",
    icon: "qoder",
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery", "device_flow"],
    accountFields: [],
  },
})
