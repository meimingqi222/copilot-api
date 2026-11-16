import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"

export const providerMetadata = defineProviderMetadata({
  protocol: "qoder-native",
  oauth: true,
  credentials: {
    primaryKey: "accessToken",
    defaultBaseUrl: "https://api3.qoder.sh",
    // COSY signing and quota/userinfo need the device identity. Without these
    // keys an exported account re-imports without them and every request fails
    // with "the saved sign-in is incomplete".
    requiredContextKeys: ["uid", "machineId"],
    contextStringKeys: [
      "name",
      "deviceToken",
      "deviceRefreshToken",
      "chatTokenKind",
      "pat",
    ],
  },
  descriptor: {
    id: "qoder",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.deviceFlow",
      hintKey: "accounts.provider.qoder.deviceHint",
      hasManualMode: true,
      importMethod: "pat",
    },
    name: "Qoder",
    icon: "qoder",
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery", "device_flow"],
    accountFields: [],
  },
})
