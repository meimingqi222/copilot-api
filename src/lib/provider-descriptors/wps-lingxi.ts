import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"

export const providerMetadata = defineProviderMetadata({
  protocol: "wps-lingxi-native",
  oauth: false,
  credentials: {
    primaryKey: "cookie",
    requiredContextKeys: ["origin"],
    exportKeys: ["cookie", "origin"],
    defaultBaseUrl: "https://lingxi.wps.cn",
  },
  descriptor: {
    id: "wps-lingxi",
    name: "WPS Lingxi (WPS 灵犀)",
    icon: "bot",
    authMode: "direct",
    presentation: {
      category: "domestic",
      badgeKey: "accounts.badge.cookie",
      hintKey: "accounts.provider.wps-lingxi.remoteHint",
      webLogin: true,
    },
    features: ["quota", "cooldown", "model_discovery"],
    accountFields: [
      {
        key: "cookie",
        type: "secret",
        labelKey: "accounts.provider.wps-lingxi.sid",
        placeholder: "wps_sid=…; uid=…",
        required: true,
      },
      {
        key: "proxyUrl",
        type: "url",
        labelKey: "accounts.oauth.fields.proxyUrl",
      },
    ],
  },
})
