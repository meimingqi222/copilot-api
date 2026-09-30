/**
 * 测试辅助:通过 connections 设置/读取测试账号状态。
 *
 * production 侧已无 Account 运行时模型(provider-connections.json 是唯一
 * 事实源),这里提供的是**仅测试用**的 account 形状视图,便于断言
 * "某个 label 的账号持有什么凭据/设置"。
 *
 * - `setTestAccounts` / `addTestAccounts` / `removeTestAccount`:写入
 *   (经 managedConnectionFromInput 构造 ProviderConnection)。
 * - `listTestAccounts` / `getTestAccount` / `connectionToTestAccount`:读取
 *   (从 ProviderConnection 派生视图)。
 */
import type { AccountModel } from "~/lib/provider-connections"
import type { ProviderConnection } from "~/lib/provider-connections"
import type { ProviderId } from "~/lib/provider-config"
import type { QuotaSnapshot } from "~/lib/quota/types"

import {
  accountManagedProvider,
  listAccountManagedConnections,
  managedConnectionFromInput,
  removeProviderConnection,
  serializeConnectionForExport,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import {
  getConnectionAuthError,
  getConnectionAuthStatus,
  getConnectionIsExhausted,
  getConnectionLastRateLimitReason,
  readConnectionMetadata,
} from "~/lib/provider-connections/connection-metadata"

/** 测试断言用的 account 形状(production 不再存在此类型)。 */
export interface TestAccount {
  id: string
  label: string
  provider: ProviderId
  enabled: boolean
  priority: number
  credentials?: Record<string, unknown>
  settings?: Record<string, unknown>
  quotaState?: "unknown" | "available" | "exhausted"
  quotaInfo?: QuotaSnapshot
  quotaExhaustedAt?: number
  availableModels?: Array<AccountModel>
  isExhausted?: boolean
  exhaustedAt?: number
  cooldownUntil?: number
  lastRateLimitAt?: number
  lastRateLimitReason?: string
  createdAt: number
  cpaMetadata?: Record<string, unknown>
  runtimeState?: {
    authStatus?: "ready" | "pending" | "error"
    lastError?: string
    copilotToken?: string
    copilotTokenExpiry?: number
    windsurfJwt?: string
    windsurfJwtFetchedAt?: number
    lastRefreshAt?: number
  }
}

/** 写入用输入:与 TestAccount 同形(缺省字段由 managedConnectionFromInput 补齐)。 */
export type TestAccountInput = Partial<
  Omit<TestAccount, "id" | "label" | "provider">
> & { id: string; label: string; provider: ProviderId }

/** 从 ProviderConnection 派生 account 形状视图(仅测试使用)。 */
export function connectionToTestAccount(conn: ProviderConnection): TestAccount {
  const serialized = serializeConnectionForExport(conn)
  const authStatus = getConnectionAuthStatus(conn)
  const authError = getConnectionAuthError(conn)
  const credential = conn.credentials[0]
  // runtimeState 按"最小子集"约定恢复:ready 且无错误时为空(与原派生一致)。
  const runtime: NonNullable<TestAccount["runtimeState"]> = {}
  if (authStatus !== "ready") {
    runtime.authStatus = authStatus as "ready" | "pending" | "error"
  }
  if (authError) runtime.lastError = authError
  if (credential?.refresherType === "copilot-token" && credential.value) {
    runtime.copilotToken = credential.value
  }
  return {
    ...(serialized as unknown as TestAccount),
    provider: accountManagedProvider(conn),
    enabled: conn.enabled,
    priority: conn.priority,
    isExhausted: getConnectionIsExhausted(conn),
    lastRateLimitAt: readConnectionMetadata(conn)?.lastRateLimitAt,
    lastRateLimitReason: getConnectionLastRateLimitReason(conn),
    runtimeState: Object.keys(runtime).length > 0 ? runtime : undefined,
  }
}

/** 列出所有 account-managed connection 的 account 视图。 */
export function listTestAccounts(): Array<TestAccount> {
  return listAccountManagedConnections().map((conn) =>
    connectionToTestAccount(conn),
  )
}

/** 按 id 查找 account 视图。 */
export function getTestAccount(id: string): TestAccount | undefined {
  const conn = listAccountManagedConnections().find((c) => c.id === id)
  return conn ? connectionToTestAccount(conn) : undefined
}

/** 写入断言用的运行时状态(如 authStatus),供测试构造异常账号。 */
export function getTestAccountRuntimeState(id: string):
  | {
      authStatus: string
      lastError: string | null
    }
  | undefined {
  const conn = listAccountManagedConnections().find((c) => c.id === id)
  if (!conn) return undefined
  return {
    authStatus: getConnectionAuthStatus(conn),
    lastError: getConnectionAuthError(conn),
  }
}

/**
 * 设置测试账号列表（替代 state.accounts = accounts）。
 * 仅清空 account-managed connections，保留非 account 来源的 connection
 * （如 openai-compatible），再将输入转换为 connections 并 upsert。
 */
export function setTestAccounts(accounts: Array<TestAccountInput>): void {
  // Collect ids first to avoid skipping elements while splicing the live array
  // returned by listProviderConnections().
  const idsToRemove = listAccountManagedConnections().map((conn) => conn.id)
  for (const id of idsToRemove) {
    removeProviderConnection(id)
  }
  addTestAccounts(accounts)
}

/** 追加账号到现有 connections。 */
export function addTestAccounts(accounts: Array<TestAccountInput>): void {
  for (const account of accounts) {
    const { label, ...rest } = account
    upsertProviderConnection(
      managedConnectionFromInput({ ...rest, name: label }),
    )
  }
}

/** 按 id 移除 account/connection。 */
export function removeTestAccount(id: string): void {
  removeProviderConnection(id)
}
