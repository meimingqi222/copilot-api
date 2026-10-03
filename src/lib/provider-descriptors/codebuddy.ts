import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

// CodeBuddy 与 CodeBuddy CN 是同一接入的两个账号域:协议、登录、能力
// 完全一致,只有 id 与展示名不同。设备流登录是主路径,手动粘贴
// JSON/accessToken 作为兜底(见添加弹窗)。刻意不进 `OAUTH_PROVIDER_IDS`,
// 以免影响旧的直连 token 分类。

export const codebuddyDescriptor: ProviderDescriptor = {
  id: "codebuddy",
  name: "CodeBuddy",
  icon: "bot",
  authMode: "oauth",
  features: ["cooldown", "model_discovery", "quota", "oauth"],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}

export const codebuddyCnDescriptor: ProviderDescriptor = {
  id: "codebuddy-cn",
  name: "CodeBuddy CN",
  icon: "bot",
  authMode: "oauth",
  features: ["cooldown", "model_discovery", "quota", "oauth"],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
