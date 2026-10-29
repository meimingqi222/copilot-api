import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "zcode-native",
  oauth: true,
  credentials: {
    primaryKey: "accessToken",
    // zcodeJwt 是 Start Plan / 限时套餐领取的会话凭证，必须跟着
    // 导出/导入往返，否则导入的账号永远领不了活动套餐。
    contextStringKeys: ["zcodeJwt", "site", "base"],
  },
  descriptor: {
    id: "zcode",
    presentation: {
      category: "domestic",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.zcode.deviceHint",
    },
    name: "ZCode",
    icon: "zcode",
    authMode: "oauth",
    features: [
      "quota",
      "cooldown",
      "native_messages",
      "oauth",
      "model_discovery",
      "device_flow",
    ],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})
