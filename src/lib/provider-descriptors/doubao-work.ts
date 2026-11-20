import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"

export const providerMetadata = defineProviderMetadata({
  protocol: "doubao-work-native",
  oauth: false,
  planBased: true,
  credentials: { primaryKey: "desktopBinding", exportKeys: [] },
  descriptor: {
    id: "doubao-work",
    name: "豆包工作 (Doubao Work)",
    icon: "bot",
    authMode: "direct",
    features: ["quota", "model_discovery"],
    accountFields: [],
    presentation: { category: "domestic", badgeKey: "accounts.badge.multi" },
  },
})
