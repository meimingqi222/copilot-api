/**
 * 测试辅助：通过 connections 设置测试账号状态。
 *
 * state.accounts 已删除，测试通过此 helper 将 Account 列表转换为
 * connections 并 upsert 到 stateRoot。读取时使用 listAccounts()。
 */
import type { Account } from "~/lib/accounts"

import {
  listProviderConnections,
  migrateAccountsToConnections,
  removeProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { readAccountLegacyMetadata } from "~/lib/provider-connections/connection-metadata"

/**
 * 设置测试账号列表（替代 state.accounts = accounts）。
 * 仅清空 account-derived connections（有 AccountLegacyMetadata 的），
 * 保留非 account 来源的 connection（如 openai-compatible），
 * 再将 accounts 转换为 connections 并 upsert。
 */
export function setTestAccounts(accounts: Array<Account>): void {
  // 仅清空 account-derived connections，保留非 account 来源的 connection。
  // Collect ids first to avoid skipping elements while splicing the live array
  // returned by listProviderConnections().
  const idsToRemove = listProviderConnections()
    .filter((conn) => readAccountLegacyMetadata(conn))
    .map((conn) => conn.id)
  for (const id of idsToRemove) {
    removeProviderConnection(id)
  }
  const connections = migrateAccountsToConnections(accounts)
  for (const conn of connections) {
    upsertProviderConnection(conn)
  }
}

/**
 * 追加 accounts 到现有 connections（替代 state.accounts.push(account)）。
 */
export function addTestAccounts(accounts: Array<Account>): void {
  const connections = migrateAccountsToConnections(accounts)
  for (const conn of connections) {
    upsertProviderConnection(conn)
  }
}

/**
 * 按 id 移除 account/connection（替代 state.accounts.splice）。
 */
export function removeTestAccount(id: string): void {
  removeProviderConnection(id)
}
