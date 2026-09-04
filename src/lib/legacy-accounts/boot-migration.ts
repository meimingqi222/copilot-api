/**
 * Boot migration 编排:accounts.json → provider-connections.json。
 *
 * Phase 3:从 account-store.ts 提取的启动迁移逻辑。
 * 处理 4 条迁移规则:
 * 1. connections 存在,accounts.json 不存在 → 直接加载 connections
 * 2. accounts.json 存在,connections 不存在 → 首次迁移
 * 3. 两者都存在 → connections 优先(可选 FORCE_REMIGRATE 强制重迁移)
 * 4. 都不存在 → 空启动
 */
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type { ProviderConnection } from "~/lib/provider-connections"

import {
  listAccounts,
  migrateAccount,
  syncLegacyExhaustedState,
  tryReadAccountsFile,
} from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import {
  initializeProviderConnections,
  listProviderConnections,
  migrateAccountsToConnections,
  saveProviderConnections,
  setProviderConnectionsForMigration,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { Mutex } from "~/lib/repository"
import { cancelConnectionTokenRefresh } from "~/services/copilot/token-refresh"
import {
  cancelAllOAuthRefreshTimers,
  scheduleOAuthRefreshForAllConnections,
} from "~/services/oauth/refresh-scheduler"

import type { Account } from "./accounts"

const accountsLifecycleMutex = new Mutex()

/**
 * 启动加载:按迁移规则加载 accounts/connections。
 */
export async function loadAccounts(): Promise<void> {
  return accountsLifecycleMutex.runExclusive(async () => {
    await loadAccountsUnlocked()
  })
}

async function loadAccountsUnlocked(): Promise<void> {
  clearAllAccountTimers()
  cancelAllOAuthRefreshTimers()

  await initializeProviderConnections()
  const existingConnections = listProviderConnections()
  const accountFile = await tryReadAccountsFile()
  const forceRemigrate = process.env.COPILOT_API_FORCE_REMIGRATE === "1"

  if (accountFile.status === "found" && existingConnections.length === 0) {
    await performFirstMigration(accountFile.accounts)
  } else if (accountFile.status === "found" && existingConnections.length > 0) {
    if (forceRemigrate) {
      await performForceRemigration(accountFile.accounts, existingConnections)
    } else {
      logger.warn(
        "accounts.json exists alongside provider-connections.json; ignoring accounts.json (already migrated). Set COPILOT_API_FORCE_REMIGRATE=1 to re-migrate from accounts.json.",
      )
      normalizeAllConnectionRuntimeFields()
      logLoadedAccounts()
    }
  } else {
    normalizeAllConnectionRuntimeFields()
    logLoadedAccounts()
  }

  // 处理 legacy GitHub token 文件(仅在无 account 时)
  if (listAccounts().length === 0) {
    try {
      const legacyToken = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
      if (legacyToken.trim()) {
        const account: Account = {
          id: randomUUID(),
          label: "default",
          provider: "copilot",
          credentials: { githubToken: legacyToken.trim() },
          settings: {},
          enabled: true,
          priority: 0,
          quotaState: "unknown",
          createdAt: Date.now(),
        }
        const conn = migrateAccountsToConnections([account])[0]
        upsertProviderConnection(conn)
        await saveProviderConnections(listProviderConnections())
        logger.info("Migrated legacy GitHub token to provider-connections.json")
        return
      }
    } catch {
      // No legacy token file
    }
  }

  scheduleOAuthRefreshForAllConnections()
}

async function performFirstMigration(
  rawAccounts: Array<Record<string, unknown>>,
): Promise<void> {
  const loadedAccounts = parseRawAccounts(rawAccounts)
  for (const account of loadedAccounts) {
    normalizeAccountRuntimeFields(account)
  }
  const migratedConnections = migrateAccountsToConnections(loadedAccounts)
  setProviderConnectionsForMigration(migratedConnections)
  await saveProviderConnections(migratedConnections)
  await renameAccountsJsonToBackup()
  logger.info(
    `First migration: ${migratedConnections.length} account(s) migrated to provider-connections.json`,
  )
  if (loadedAccounts.length === 0) {
    logger.warn("No accounts loaded from disk")
  } else {
    logger.info(
      `Loaded ${loadedAccounts.length} account(s): ${loadedAccounts.map((a) => a.label).join(", ")}`,
    )
  }
  logLoadedAccounts()
}

async function performForceRemigration(
  rawAccounts: Array<Record<string, unknown>>,
  existingConnections: Array<ProviderConnection>,
): Promise<void> {
  const loadedAccounts = parseRawAccounts(rawAccounts)
  for (const account of loadedAccounts) {
    normalizeAccountRuntimeFields(account)
  }
  const migratedConnections = migrateAccountsToConnections(loadedAccounts)
  const mergedConnections = mergeConnectionsById(
    existingConnections,
    migratedConnections,
  )
  setProviderConnectionsForMigration(mergedConnections)
  await saveProviderConnections(mergedConnections)
  await renameAccountsJsonToBackup()
  logger.info(
    `Force re-migration: ${migratedConnections.length} account(s) re-migrated and merged with ${existingConnections.length} existing connection(s)`,
  )
  logLoadedAccounts()
}

async function renameAccountsJsonToBackup(): Promise<void> {
  try {
    const backupPath = `${PATHS.ACCOUNTS_PATH}.migrated-${Date.now()}.bak`
    await fs.rename(PATHS.ACCOUNTS_PATH, backupPath)
    logger.info(`Renamed accounts.json to ${backupPath}`)
  } catch (error) {
    logger.warn(
      `Failed to rename accounts.json: ${(error as Error).message}. provider-connections.json is authoritative; accounts.json will be ignored on next startup.`,
    )
  }
}

function parseRawAccounts(
  rawAccounts: Array<Record<string, unknown>>,
): Array<Account> {
  const loadedAccounts: Array<Account> = []
  for (const raw of rawAccounts) {
    try {
      loadedAccounts.push(migrateAccount(raw))
    } catch (err) {
      logger.warn(`Skipping invalid account entry: ${(err as Error).message}`)
    }
  }
  return loadedAccounts
}

function normalizeAccountRuntimeFields(account: Account): void {
  if (typeof account.cooldownUntil === "number") {
    if (account.cooldownUntil <= Date.now()) {
      account.cooldownUntil = undefined
    }
  } else {
    account.cooldownUntil = undefined
  }
  account.lastRateLimitAt = undefined
  account.lastRateLimitReason = undefined
  syncLegacyExhaustedState(account)
}

function normalizeConnectionRuntimeFields(conn: ProviderConnection): void {
  const now = Date.now()
  for (const cred of conn.credentials) {
    if (typeof cred.cooldownUntil === "number") {
      if (cred.cooldownUntil <= now) {
        cred.cooldownUntil = undefined
        if (cred.status === "cooldown" || cred.status === "quota_exhausted") {
          cred.status = cred.enabled ? "ready" : "disabled"
        }
      }
    } else {
      cred.cooldownUntil = undefined
    }
  }
  const meta = conn.metadata
  if (meta) {
    if (typeof meta.cooldownUntil === "number") {
      if (meta.cooldownUntil <= now) {
        meta.cooldownUntil = undefined
      }
    } else {
      meta.cooldownUntil = undefined
    }
    delete meta.lastRateLimitAt
    delete meta.lastRateLimitReason
  }
}

function normalizeAllConnectionRuntimeFields(): void {
  for (const conn of listProviderConnections()) {
    normalizeConnectionRuntimeFields(conn)
  }
}

function logLoadedAccounts(): void {
  const accounts = listAccounts()
  if (accounts.length === 0) {
    logger.warn("No accounts loaded from connections")
  } else {
    logger.info(
      `Loaded ${accounts.length} account(s) from connections: ${accounts.map((a) => a.label).join(", ")}`,
    )
  }
}

function mergeConnectionsById(
  existing: Array<ProviderConnection>,
  migrated: Array<ProviderConnection>,
): Array<ProviderConnection> {
  const merged = new Map<string, ProviderConnection>()
  for (const conn of existing) {
    merged.set(conn.id, conn)
  }
  for (const conn of migrated) {
    merged.set(conn.id, conn)
  }
  return [...merged.values()]
}

function clearAllAccountTimers(): void {
  for (const conn of listProviderConnections()) {
    cancelConnectionTokenRefresh(conn.id)
  }
}

export { accountsLifecycleMutex }
