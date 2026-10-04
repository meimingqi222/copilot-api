import {
  PROVIDER_IDS,
  PROVIDER_DEFINITIONS,
  OAUTH_PROVIDER_IDS,
  type ProviderId,
  type OAuthProviderId,
} from "~/lib/provider-definitions"
export {
  PROVIDER_PROTOCOL_MAP,
  OAUTH_PROVIDER_IDS,
} from "~/lib/provider-definitions"
export type { ProviderId, OAuthProviderId } from "~/lib/provider-definitions"
export type {
  ProviderDescriptor,
  ProviderFeature,
} from "~/lib/provider-descriptors/types"
import {
  getProviderDescriptor,
  type ProviderDescriptor,
} from "~/lib/provider-descriptors"

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId)
}

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return OAUTH_PROVIDER_IDS.includes(value as OAuthProviderId)
}

/**
 * Provider 的产品是「订阅套餐」而非「预付费钱包」的集合。
 *
 * 套餐把额度报成滚动窗口的份额（quota 子系统），而不是钱包里的钱。这类
 * provider 的计费端点描述的是套餐 credits，不是余额：按钱包读它会把一个
 * 额度充足的账号读成 `$0.00`，进而被余额闸门踢出路由（见 lib/balance）。
 * 因此它们不参与余额探测——真正的耗尽交给 windowLimits / 上游 402 的
 * quota 路径。
 */
export function isPlanBasedProvider(value: string): boolean {
  if (!isProviderId(value)) return false
  const definition = PROVIDER_DEFINITIONS[value]
  return "planBased" in definition && definition.planBased === true
}

/** OAuth provider 的账号描述。数据本体在各 provider 的 descriptor 文件里。 */
export function getOAuthProviderDescriptor(
  provider: OAuthProviderId,
): ProviderDescriptor {
  return getProviderDescriptor(provider)
}
