import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "codearts-native",
  oauth: true,
  credentials: {
    primaryKey: "accessToken",
    defaultBaseUrl: "https://snap-access.cn-north-4.myhuaweicloud.com",
    requiredContextKeys: [
      "secretAccessKey",
      "securityToken",
      "codeartsStation",
      "codeartsVerifier",
      "codeartsDpopKey",
    ],
  },
  descriptor: {
    id: "codearts",
    name: "Huawei CodeArts",
    icon: "codearts",
    authMode: "oauth",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.oauth",
      manualOAuthCallback: true,
    },
    features: ["quota", "cooldown", "oauth", "model_discovery"],
    accountFields: [
      {
        key: "region",
        type: "select",
        labelKey: "accounts.provider.codearts.region",
        options: [
          {
            label: "Mainland China",
            labelKey: "accounts.provider.codearts.regionCn",
            value: "cn",
          },
          {
            label: "International",
            labelKey: "accounts.provider.codearts.regionIntl",
            value: "en",
          },
        ],
      },
      ...OAUTH_ACCOUNT_FIELDS,
    ],
  },
})
