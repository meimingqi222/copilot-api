/**
 * 测试辅助：通过 connections 设置 state.accounts（替代 state.accounts = [...]）。
 *
 * 批次 2 后 state.accounts 是 getter，不能直接赋值。
 * 测试通过此 helper 将 Account 列表转换为 connections 并 upsert 到 stateRoot。
 */
import type { Account } from "~/lib/accounts"

import {
  listProviderConnections,
  migrateAccountsToConnections,
  removeProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { readAccountLegacyMetadata } from "~/lib/provider-connections/connection-metadata"
import { state } from "~/lib/state"

/**
 * 设置 state.accounts 为指定列表（替代 state.accounts = accounts）。
 * 仅清空 account-derived connections（有 AccountLegacyMetadata 的），
 * 保留非 account 来源的 connection（如 openai-compatible），
 * 再将 accounts 转换为 connections 并 upsert，同时直接设置 state.accounts
 * 以保留对象引用（测试中 buildRouteTargets 需要 referential equality）。
 */
export function setTestAccounts(accounts: Array<Account>): void {
  // 仅清空 account-derived connections，保留非 account 来源的 connection
  for (const conn of listProviderConnections()) {
    if (readAccountLegacyMetadata(conn)) {
      removeProviderConnection(conn.id)
    }
  }
  const connections = migrateAccountsToConnections(accounts)
  for (const conn of connections) {
    upsertProviderConnection(conn)
  }
  // 直接设置 state.accounts 以保留对象引用
  // （生产代码通过 syncAccountsFromConnections 重建，但测试需要 referential equality）
  state.accounts = accounts
}

/**
 * 追加 accounts 到现有 connections（替代 state.accounts.push(account)）。
 */
export function addTestAccounts(accounts: Array<Account>): void {
  const connections = migrateAccountsToConnections(accounts)
  for (const conn of connections) {
    upsertProviderConnection(conn)
  }
  state.accounts = [...state.accounts, ...accounts]
}

/**
 * 按 id 移除 account/connection（替代 state.accounts.splice）。
 */
export function removeTestAccount(id: string): void {
  removeProviderConnection(id)
  state.accounts = state.accounts.filter((a) => a.id !== id)
}
