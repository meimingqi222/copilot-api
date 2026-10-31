import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"

export const providerMetadata = defineProviderMetadata({
  protocol: "qoder-native",
  oauth: true,
  credentials: {
    primaryKey: "accessToken",
    // COSY signing and quota/userinfo need the device identity. Without these
    // keys an exported account re-imports without them and every request fails
    // with "the saved sign-in is incomplete".
    contextStringKeys: [
      "uid",
      "machineId",
      "deviceToken",
      "deviceRefreshToken",
      "chatTokenKind",
    ],
  },
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
