import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type { Account } from "~/lib/accounts"
import type { ProviderConnection } from "~/lib/provider-connections"

import { syncLegacyExhaustedState } from "~/lib/account-availability"
import {
  accountsDiskHasRecoverableData,
  tryReadAccountsFile,
} from "~/lib/account-file-store"
import { migrateAccount } from "~/lib/account-legacy-migrator"
import {
  getAccountProvider,
  getCodebuffAuthToken,
  getGitHubToken,
  getMimoPh,
  getMimoServiceToken,
  getWindsurfApiKey,
  listAccounts,
} from "~/lib/accounts"
import { GITHUB_API_BASE_URL, githubApiHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { isOAuthProviderId } from "~/lib/provider-config"
import {
  getMutableProviderConnection,
  initializeProviderConnections,
  listProviderConnections,
  migrateAccountsToConnections,
  saveProviderConnections,
  setProviderConnectionsForMigration,
  syncAccountToConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { Mutex } from "~/lib/repository"
import { state } from "~/lib/state"
import { emitStateChange } from "~/lib/state-events"
import { globalTimers } from "~/lib/timer-registry"
import {
  cancelAllOAuthRefreshTimers,
  scheduleOAuthRefreshForAllAccounts,
} from "~/services/oauth/refresh-scheduler"

const QUOTA_EXHAUSTION_THRESHOLD = 5
const QUOTA_RECHECK_INTERVAL_MS = 5 * 60 * 1000
const TOKEN_REFRESH_RETRY_DELAY_MS = 60_000

const tokenRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const accountsLifecycleMutex = new Mutex()

export interface SaveAccountsOptions {
  /** Allow persisting an empty list (e.g. user deleted the last account). */
  allowEmpty?: boolean
  /** Allow reducing the number of accounts on disk (e.g. user deleted accounts). */
  allowShrink?: boolean
}

export async function loadAccounts(): Promise<void> {
  return accountsLifecycleMutex.runExclusive(async () => {
    await loadAccountsUnlocked()
  })
}

async function loadAccountsUnlocked(): Promise<void> {
  clearAllAccountTimers()
  cancelAllOAuthRefreshTimers()

  // ── 持久化格式换底 ──────────────────────────────────
  // 先加载 provider-connections.json，再按 2.3 的 4 条规则检测迁移状态。
  // accounts.json 永不复活——saveAccounts() 委托 saveProviderConnections()。
  await initializeProviderConnections()
  const existingConnections = listProviderConnections()
  const accountFile = await tryReadAccountsFile()
  const forceRemigrate = process.env.COPILOT_API_FORCE_REMIGRATE === "1"

  if (accountFile.status === "found" && existingConnections.length === 0) {
    // 规则 2：首次迁移——accounts.json 存在，connections 不存在
    await performFirstMigration(accountFile.accounts)
  } else if (accountFile.status === "found" && existingConnections.length > 0) {
    // 规则 3：两者都存在——connections 优先
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
    // 规则 1（connections 存在，accounts.json 不存在）或规则 4（都不存在）
    normalizeAllConnectionRuntimeFields()
    logLoadedAccounts()
  }

  // 处理 legacy GitHub token 文件（仅在无 account 时）
  if (listAccounts().length === 0) {
    try {
      const legacyToken = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
      if (legacyToken.trim()) {
        const account: Account = {
          id: randomUUID(),
          label: "default",
          provider: "copilot",
          credentials: {
            githubToken: legacyToken.trim(),
          },
          settings: {},
          enabled: true,
          priority: 0,
          quotaState: "unknown",
          createdAt: Date.now(),
        }
        const conn = migrateAccountsToConnections([account])[0]
        upsertProviderConnection(conn)
        await saveAccountsUnlocked()
        logger.info("Migrated legacy GitHub token to provider-connections.json")
        return
      }
    } catch {
      // No legacy token file either
    }
  }

  scheduleOAuthRefreshForAllAccounts()
}

/**
 * 规则 2：首次迁移——将 accounts.json 逐条迁移为 connections，
 * 写入 provider-connections.json，重命名 accounts.json 为备份。
 */
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
      `Loaded ${loadedAccounts.length} account(s): ${loadedAccounts.map((account) => account.label).join(", ")}`,
    )
  }
  logLoadedAccounts()
}

/**
 * 规则 3 + COPILOT_API_FORCE_REMIGRATE=1：强制重迁移——
 * 按 id 合并（accounts.json 迁移出的 connection 覆盖同名 connection，
 * 其余 connection 保留），永不整体覆盖。
 */
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

/**
 * 将 accounts.json 重命名为 accounts.json.migrated-<timestamp>.bak（不删除，供回滚）。
 */
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

/**
 * 从 raw accounts 数组解析为 Account 对象列表。
 */
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

/**
 * 规范化 account 的运行时字段（cooldownUntil、lastRateLimit、exhaustedState）。
 */
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

/**
 * 规范化 connection 的运行时字段（cooldownUntil、lastRateLimit）。
 * 镜像原 normalizeAccountRuntimeFields 的逻辑，但直接操作 connection。
 */
function normalizeConnectionRuntimeFields(conn: ProviderConnection): void {
  const now = Date.now()
  const cred = conn.credentials[0]
  if (typeof cred.cooldownUntil === "number") {
    if (cred.cooldownUntil <= now) {
      cred.cooldownUntil = undefined
    }
  } else {
    cred.cooldownUntil = undefined
  }
  // Also normalize metadata.cooldownUntil (connectionToAccount falls back to it)
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

/**
 * 规范化所有 account-derived connections 的运行时字段。
 */
function normalizeAllConnectionRuntimeFields(): void {
  for (const conn of listProviderConnections()) {
    const meta = conn.metadata
    if (!meta || !meta.provider) continue // skip non-account connections
    normalizeConnectionRuntimeFields(conn)
  }
}

/**
 * 输出已加载账号列表的日志。
 */
function logLoadedAccounts(): void {
  const accounts = listAccounts()
  if (accounts.length === 0) {
    logger.warn("No accounts loaded from connections")
  } else {
    logger.info(
      `Loaded ${accounts.length} account(s) from connections: ${accounts.map((account) => account.label).join(", ")}`,
    )
  }
}

/**
 * 按 id 合并 connections：account-derived connections 覆盖同名 connection，
 * 其余 connection 保留。永不整体覆盖。
 */
function mergeConnectionsById(
  existing: Array<ProviderConnection>,
  migrated: Array<ProviderConnection>,
): Array<ProviderConnection> {
  const merged = new Map<string, ProviderConnection>()
  for (const conn of existing) {
    merged.set(conn.id, conn)
  }
  for (const conn of migrated) {
    merged.set(conn.id, conn) // migrated 覆盖同名
  }
  return [...merged.values()]
}

export async function saveAccounts(
  options: SaveAccountsOptions = {},
): Promise<void> {
  return accountsLifecycleMutex.runExclusive(async () => {
    await saveAccountsUnlocked(options)
  })
}

/** Flush in-memory accounts on shutdown (waits for in-flight saves). */
export async function flushAccountsOnShutdown(): Promise<void> {
  return accountsLifecycleMutex.runExclusive(async () => {
    if (listAccounts().length === 0) return
    await saveProviderConnections(listProviderConnections())
  })
}

async function saveAccountsUnlocked(
  options: SaveAccountsOptions = {},
): Promise<void> {
  const accountCount = listAccounts().length
  if (accountCount === 0 && !options.allowEmpty) {
    const diskHasData =
      listProviderConnections().length > 0
      || (await accountsDiskHasRecoverableData())
      || (await connectionsDiskHasData())
    if (diskHasData) {
      logger.warn(
        "Refusing to persist empty accounts snapshot while existing data is on disk",
      )
      return
    }
  }

  await saveProviderConnections(listProviderConnections())
  // 持久化完成后通知 models-stale,触发 cacheModels() 重建缓存
  emitStateChange("models-stale")
}

/**
 * 检查 provider-connections.json 磁盘文件是否有数据。
 */
async function connectionsDiskHasData(): Promise<boolean> {
  try {
    const raw = await fs.readFile(PATHS.PROVIDER_CONNECTIONS_PATH)
    const parsed = JSON.parse(raw.toString("utf8")) as {
      connections?: Array<unknown>
    }
    return (parsed.connections?.length ?? 0) > 0
  } catch {
    return false
  }
}

export function serializeAccountForExport(
  account: Account,
): Record<string, unknown> {
  return serializeAccount(account)
}

function serializeAccount(account: Account): Record<string, unknown> {
  syncLegacyExhaustedState(account)
  const base: Record<string, unknown> = {
    id: account.id,
    label: account.label,
    provider: account.provider,
    enabled: account.enabled,
    priority: account.priority,
    quotaState: account.quotaState ?? "unknown",
    quotaExhaustedAt: account.quotaExhaustedAt,
    createdAt: account.createdAt,
    availableModels: account.availableModels,
    quotaInfo: account.quotaInfo,
    cooldownUntil: account.cooldownUntil,
  }

  // Never persist runtimeState — short-lived tokens (copilotToken,
  // windsurfJwt, authStatus) stay in memory only.
  if (account.provider === "copilot") {
    return {
      ...base,
      credentials: {
        githubToken: getGitHubToken(account),
      },
      settings: account.settings ?? {},
    }
  }

  if (account.provider === "codebuff") {
    return {
      ...base,
      credentials: {
        authToken: getCodebuffAuthToken(account),
      },
      settings: account.settings ?? {},
    }
  }

  if (account.provider === "windsurf") {
    return {
      ...base,
      credentials: {
        apiKey: getWindsurfApiKey(account),
      },
      settings: account.settings ?? {},
    }
  }

  if (isOAuthProviderId(account.provider)) {
    return {
      ...base,
      credentials: account.credentials ?? {},
      settings: account.settings ?? {},
      ...(account.cpaMetadata ? { cpaMetadata: account.cpaMetadata } : {}),
    }
  }

  return {
    ...base,
    credentials: {
      serviceToken: getMimoServiceToken(account),
      xiaomichatbotPh: getMimoPh(account),
      mimoWsToken: account.credentials?.mimoWsToken,
    },
    settings: account.settings ?? {},
  }
}

function scheduleTokenRefreshRetry(accountId: string): void {
  const conn = getMutableProviderConnection(accountId)
  if (!conn || !conn.enabled) {
    tokenRefreshTimers.delete(accountId)
    return
  }
  logger.warn(
    `Scheduling token refresh retry for account "${accountId}" in ${TOKEN_REFRESH_RETRY_DELAY_MS / 1000}s`,
  )
  const retryTimerId = setTimeout(() => {
    const currentConn = getMutableProviderConnection(accountId)
    if (!currentConn || !currentConn.enabled) {
      tokenRefreshTimers.delete(accountId)
      return
    }
    const currentAccount = listAccounts().find((a) => a.id === accountId)
    if (!currentAccount) {
      tokenRefreshTimers.delete(accountId)
      return
    }
    refreshCopilotToken(currentAccount).catch((error: unknown) => {
      logger.error(
        `Token refresh retry failed for "${currentAccount.label}":`,
        error,
      )
      scheduleTokenRefreshRetry(accountId)
    })
  }, TOKEN_REFRESH_RETRY_DELAY_MS)
  tokenRefreshTimers.set(accountId, retryTimerId)
}

export async function refreshCopilotToken(account: Account): Promise<void> {
  if (getAccountProvider(account) !== "copilot" || !account.enabled) {
    return
  }

  const githubToken = getGitHubToken(account)
  if (!githubToken) {
    // No token yet — account can be added later via Web UI
    return
  }

  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: {
        ...githubApiHeaders(),
        authorization: `token ${githubToken}`,
      },
    },
  )

  if (!response.ok) {
    const body = await response.text()
    throw new HTTPError(
      "Failed to get Copilot token for account",
      response,
      body,
    )
  }

  const data = (await response.json()) as {
    token: string
    expires_at: number
    refresh_in: number
  }

  // Update account snapshot's runtimeState so subsequent syncAccountToConnection
  // calls don't overwrite the new token with the stale value.
  account.runtimeState = {
    ...account.runtimeState,
    copilotToken: data.token,
    copilotTokenExpiry: data.expires_at * 1000,
  }

  // Sync the full account state (including new token) to the connection
  const conn = getMutableProviderConnection(account.id)
  if (conn) {
    syncAccountToConnection(conn, account)
    await saveProviderConnections(listProviderConnections())
  }

  if (state.showToken) {
    logger.info(`Copilot token for "${account.label}":`, data.token)
  }

  const refreshInterval = Math.max((data.refresh_in - 60) * 1000, 60_000)
  const existingTimer = tokenRefreshTimers.get(account.id)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const accountId = account.id
  const timerId = setTimeout(() => {
    const currentConn = getMutableProviderConnection(accountId)
    if (!currentConn || !currentConn.enabled) {
      tokenRefreshTimers.delete(accountId)
      return
    }
    const currentAccount = listAccounts().find((a) => a.id === accountId)
    if (!currentAccount) {
      tokenRefreshTimers.delete(accountId)
      return
    }

    logger.debug(`Refreshing Copilot token for "${currentAccount.label}"`)
    refreshCopilotToken(currentAccount).catch((error: unknown) => {
      logger.error(
        `Failed to refresh Copilot token for "${currentAccount.label}":`,
        error,
      )
      scheduleTokenRefreshRetry(accountId)
    })
  }, refreshInterval)

  tokenRefreshTimers.set(account.id, timerId)
}

export function cancelTokenRefreshTimer(accountId: string): void {
  const timerId = tokenRefreshTimers.get(accountId)
  if (timerId) {
    clearTimeout(timerId)
    tokenRefreshTimers.delete(accountId)
    logger.debug(`Cancelled token refresh timer for account "${accountId}"`)
  }
}

function clearAllAccountTimers(): void {
  for (const account of listAccounts()) {
    cancelTokenRefreshTimer(account.id)
  }
}

export async function initAccounts(): Promise<void> {
  await loadAccounts()
}

export function scheduleQuotaRefresh(): void {
  void refreshAllQuotas()
  globalTimers.interval(() => {
    void refreshAllQuotas()
  }, QUOTA_RECHECK_INTERVAL_MS)
}

export async function refreshQuotaForAccount(
  account: Account,
  skipSave = false,
): Promise<void> {
  if (getAccountProvider(account) !== "copilot") {
    return
  }

  const usage = await getCopilotUsageForAccount(account)
  const snapshot = snapshotFromUsage(usage)
  const remaining = snapshot.premiumInteractionsRemaining ?? Infinity
  const unlimited = snapshot.unlimited
  const exhausted = !unlimited && remaining <= QUOTA_EXHAUSTION_THRESHOLD

  // Update account snapshot so callers see fresh values
  account.quotaInfo = snapshot
  if (exhausted) {
    if (account.quotaState !== "exhausted") {
      account.quotaState = "exhausted"
      account.quotaExhaustedAt = Date.now()
      logger.warn(`Account "${account.label}" quota exhausted`)
    }
  } else {
    if (account.quotaState === "exhausted") {
      logger.info(`Account "${account.label}" quota refreshed — re-activating`)
    }
    account.quotaState = "available"
    account.quotaExhaustedAt = undefined
  }

  // Sync to connection
  const conn = getMutableProviderConnection(account.id)
  if (conn) syncAccountToConnection(conn, account)
  if (!skipSave) {
    await saveAccounts()
  }
}

async function refreshAllQuotas(): Promise<void> {
  const accounts = listAccounts()
  const results = await Promise.allSettled(
    accounts.map((account) => refreshQuotaForAccount(account, true)),
  )
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("Failed to refresh quota for account:", result.reason)
    }
  }
  await saveAccounts()
}

async function getCopilotUsageForAccount(account: Account): Promise<{
  quota_snapshots?: {
    premium_interactions?: {
      remaining: number
      entitlement: number
      unlimited: boolean
    }
    chat?: { remaining: number; entitlement: number; unlimited: boolean }
    completions?: { remaining: number; entitlement: number; unlimited: boolean }
  }
}> {
  const githubToken = getGitHubToken(account)
  if (!githubToken) {
    throw new Error(`GitHub token missing for account "${account.label}"`)
  }

  const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: {
      ...githubApiHeaders(),
      authorization: `token ${githubToken}`,
    },
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot usage", response)
  }

  return (await response.json()) as Awaited<
    ReturnType<typeof getCopilotUsageForAccount>
  >
}

function snapshotFromUsage(
  usage: Awaited<ReturnType<typeof getCopilotUsageForAccount>>,
) {
  const snapshots = usage.quota_snapshots ?? {}
  const premium = snapshots.premium_interactions
  const chat = snapshots.chat
  const completions = snapshots.completions

  const unlimited = Boolean(
    premium?.unlimited || chat?.unlimited || completions?.unlimited,
  )

  return {
    fetchedAt: Date.now(),
    premiumInteractionsRemaining: premium?.remaining,
    premiumInteractionsTotal: premium?.entitlement,
    chatRemaining: chat?.remaining,
    chatTotal: chat?.entitlement,
    completionsRemaining: completions?.remaining,
    completionsTotal: completions?.entitlement,
    unlimited,
  }
}
