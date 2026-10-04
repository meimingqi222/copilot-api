import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"

export const providerMetadata = defineProviderMetadata({
  protocol: "copilot-native",
  oauth: false,
  descriptor: {
    id: "copilot",
    presentation: {
      category: "popular",
      badgeKey: "accounts.badge.deviceFlow",
      hintKey: "accounts.deviceFlow.step1",
    },
    name: "Copilot",
    icon: "github",
    authMode: "device_flow",
    features: [
      "quota",
      "cooldown",
      "native_responses",
      "native_messages",
      "embeddings",
      "device_flow",
      "model_discovery",
    ],
    accountFields: [],
  },
})
