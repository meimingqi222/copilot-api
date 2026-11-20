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
        labelKey: "Huawei Cloud region",
        options: [
          { label: "Mainland China", value: "cn" },
          { label: "International", value: "en" },
        ],
      },
      ...OAUTH_ACCOUNT_FIELDS,
    ],
  },
})
