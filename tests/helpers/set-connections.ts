/**
 * 测试辅助:直接通过 ProviderConnection 设置测试状态(connection 原生)。
 *
 * Phase 2:仿 set-accounts.ts 模式,但直接操作 ProviderConnection 而非 Account。
 * 新测试应优先使用此 helper,逐步替代 set-accounts.ts。
 */
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  listProviderConnections,
  removeProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { isAccountManagedConnection } from "~/lib/provider-connections"

/**
 * 设置测试 connection 列表(替代 setTestAccounts)。
 * 仅清空 account-managed connections,保留非 account 来源的 connection。
 */
export function setTestConnections(
  connections: Array<ProviderConnection>,
): void {
  // 仅清空 account-managed connections
  const idsToRemove = listProviderConnections()
    .filter((conn) => isAccountManagedConnection(conn))
    .map((conn) => conn.id)
  for (const id of idsToRemove) {
    removeProviderConnection(id)
  }
  for (const conn of connections) {
    upsertProviderConnection(conn)
  }
}

/**
 * 追加 connections 到现有 stateRoot。
 */
export function addTestConnections(
  connections: Array<ProviderConnection>,
): void {
  for (const conn of connections) {
    upsertProviderConnection(conn)
  }
}

/**
 * 按 id 移除 connection。
 */
export function removeTestConnection(id: string): void {
  removeProviderConnection(id)
}
