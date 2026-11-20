import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "dumate-native",
  oauth: false,
  credentials: {
    primaryKey: "cookie",
    exportKeys: ["cookie", "dumateCatalog"],
    contextValueKeys: ["dumateCatalog"],
    defaultBaseUrl: "https://dumate-svc.baidu.com/gateway/apis/v1",
  },
  descriptor: {
    id: "dumate",
    name: "Baidu DuMate",
    icon: "bot",
    authMode: "direct",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.cookie",
      hintKey: "accounts.provider.dumate.remoteHint",
      webLogin: true,
    },
    features: ["quota", "cooldown", "model_discovery"],
    accountFields: [
      {
        key: "cookie",
        type: "secret",
        labelKey: "accounts.provider.dumate.cookie",
        placeholder: "bce-sessionid=...",
      },
      ...OAUTH_ACCOUNT_FIELDS,
    ],
  },
})
