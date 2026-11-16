import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"
import { providerMetadata as traeCnMetadata } from "~/lib/provider-descriptors/trae-cn"

/**
 * Trae Global（trae.ai，字节跳动 AI IDE 国际站）：与 Trae CN 协议一致、账号
 * 互不相通，共用 trae-cn-native 协议与同一套机器（按 connection 选站点）。
 * 浏览器授权 → loopback 回调拿 Cloud-IDE-JWT + refresh token；美元计费，
 * US/SG 双部署由登录的 region 选择。
 */
export const providerMetadata = defineProviderMetadata({
  protocol: "trae-cn-native",
  oauth: true,
  credentials: traeCnMetadata.credentials,
  descriptor: {
    id: "trae-global",
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.trae-global.deviceHint",
      manualOAuthCallback: true,
    },
    name: "Trae Global",
    icon: "trae",
    authMode: "oauth",
    features: ["quota", "cooldown", "oauth", "model_discovery"],
    accountFields: OAUTH_ACCOUNT_FIELDS,
  },
})
