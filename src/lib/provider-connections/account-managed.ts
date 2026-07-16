/**
 * Account-managed connection 判别器。
 *
 * protocol 空间天然二分:
 * - *-native(9 个,对应 PROVIDER_PROTOCOL_MAP 的值域)→ 账号管理面
 *   (/admin/api/accounts),由 copilot/OAuth/windsurf/mimo 等账号生命周期管理。
 * - *-compatible(openai/openai-responses/anthropic 3 个)→ 外部 Provider
 *   管理面(/admin/api/provider-connections),手工配置的上游端点。
 *
 * 此判别器从 protocol 派生,不依赖 AccountLegacyMetadata(后者是过渡态,
 * T5.2.5 会删除 metadata.provider 字段)。protocol 是 ProviderConnection
 * 的本体字段,不会被 Schema 归一化删除,因此此谓词在 T5.2.5 后仍然有效。
 */

import { PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"

import type { ProviderConnection, ProviderProtocol } from "./types"

/**
 * 账号管理面管辖的 protocol 集合。
 * 从 PROVIDER_PROTOCOL_MAP 的值域派生,新增 provider 时自动覆盖。
 */
const ACCOUNT_MANAGED_PROTOCOLS = new Set<ProviderProtocol>(
  Object.values(PROVIDER_PROTOCOL_MAP),
)

/**
 * 判断一个 protocol 是否属于账号管理面(*-native)。
 */
export function isAccountManagedProtocol(protocol: ProviderProtocol): boolean {
  return ACCOUNT_MANAGED_PROTOCOLS.has(protocol)
}

/**
 * 判断一个 connection 是否由账号管理面管辖。
 *
 * account-managed connection 只能通过 /admin/api/accounts 路径管理,
 * 不应出现在外部 provider 列表(/admin/api/provider-connections)中,
 * 也不允许通过外部 provider API 操作。
 */
export function isAccountManagedConnection(conn: ProviderConnection): boolean {
  return isAccountManagedProtocol(conn.protocol)
}
