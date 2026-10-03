import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

/**
 * Trae CN（trae.cn，字节跳动 AI IDE）：
 * 浏览器授权 → loopback 回调拿 Cloud-IDE-JWT + refresh token；
 * 聊天走 IDE agent 的私有 SSE 端点（trae-cn-native adapter）。
 */
export const providerMetadata = defineProviderMetadata({
  protocol: "trae-cn-native",
  oauth: true,
  descriptor: {
    id: "trae-cn",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.trae-cn.deviceHint",
    },
    name: "Trae CN",
    icon: "trae",
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery"],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})

export const descriptor = providerMetadata.descriptor
