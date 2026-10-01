/**
 * Protocol ↔ Provider 派生工具 + account-managed connection 视图。
 *
 * Step D 收尾(Phase 1):路由/dispatch 层不再经由
 * `connection → Account → connection` 的往返派生,直接以
 * ProviderConnection 为事实源。本模块提供原先寄居于
 * connection-to-account.ts / accounts.ts 的派生逻辑的 connection 原生版本。
 *
 * - PROTOCOL_TO_PROVIDER / providerFromProtocol:协议反查 provider
 *   (原 connection-to-account.ts 中的私有 map)。
 * - listAccountManagedConnections:listAccounts() 的 connection 级替代。
 * - accountManagedProvider:connectionToAccount 的 provider 派生
 *   (metadata.provider 优先,protocol 反查兜底)。
 * - accountManagedModelPrefix:getAccountModelPrefix 的 connection 级替代
 *   (OAuth 自定义 modelPrefix 优先,provider 兜底)。
 */

import { isOAuthProviderId, type ProviderId } from "~/lib/provider-config"
import { PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"

import type { ProviderConnection, ProviderProtocol } from "./types"

import { isAccountManagedConnection } from "./account-managed"
import { readConnectionMetadata } from "./connection-metadata"
import { listProviderConnections } from "./state"

/**
 * Protocol → ProviderId 反向映射(从 PROVIDER_PROTOCOL_MAP 派生)。
 */
const PROTOCOL_TO_PROVIDER: Partial<Record<ProviderProtocol, ProviderId>> = {}
for (const [providerId, protocol] of Object.entries(PROVIDER_PROTOCOL_MAP)) {
  PROTOCOL_TO_PROVIDER[protocol] = providerId as ProviderId
}

/**
 * 协议反查 provider。未注册的 protocol 返回 undefined。
 */
export function providerFromProtocol(
  protocol: ProviderProtocol,
): ProviderId | undefined {
  return PROTOCOL_TO_PROVIDER[protocol]
}

/**
 * 列出所有 account-managed connections(原 listAccounts() 的 connection 级替代)。
 */
export function listAccountManagedConnections(): Array<ProviderConnection> {
  return listProviderConnections().filter((conn) =>
    isAccountManagedConnection(conn),
  )
}

/**
 * account-managed connection 的 provider 派生。
 * 镜像 connectionToAccount:metadata.provider 优先,protocol 反查兜底。
 *
 * Account-managed protocol 都来自 PROVIDER_PROTOCOL_MAP 的值域,反查必然
 * 命中;命中不了只可能是把非 account-managed 协议传了进来 —— 那是调用方
 * 的错误,直接报错而不是静默当成 copilot。
 */
export function accountManagedProvider(conn: ProviderConnection): ProviderId {
  const fromMetadata = readConnectionMetadata(conn)?.provider
  if (fromMetadata) return fromMetadata
  const provider = providerFromProtocol(conn.protocol)
  if (!provider) {
    throw new Error(`No provider registered for protocol "${conn.protocol}"`)
  }
  return provider
}

/**
 * connection 的 provider 统一派生(原 `admission.account?.provider ?? target.protocol`
 * 的 connection 原生替代)。
 *
 * - account-managed connection:metadata.provider 优先,protocol 反查兜底。
 * - plain connection(*-compatible):直接用 protocol(openai/anthropic 等)。
 */
export function connectionProvider(conn: ProviderConnection): string {
  if (!isAccountManagedConnection(conn)) return conn.protocol
  return accountManagedProvider(conn)
}

/**
 * account-managed connection 的模型前缀。
 * 镜像 getAccountModelPrefix:OAuth 自定义 modelPrefix(trim 后非空)优先,
 * 否则用 provider 本身。
 */
export function accountManagedModelPrefix(conn: ProviderConnection): string {
  const meta = readConnectionMetadata(conn)
  if (meta) {
    if (isOAuthProviderId(meta.provider)) {
      const custom =
        typeof meta.modelPrefix === "string" ?
          meta.modelPrefix.trim()
        : undefined
      if (custom) return custom
    }
    return meta.provider
  }
  return accountManagedProvider(conn)
}
