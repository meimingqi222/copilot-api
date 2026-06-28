import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type {
  Account,
  AccountProvider,
  AccountQuotaState,
  AccountRuntimeState,
} from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import {
  syncLegacyExhaustedState,
  setAccountQuotaState,
} from "~/lib/account-availability"
import {
  accountsDiskHasRecoverableData,
  tryReadAccountsFile,
  writeAccountsFile,
} from "~/lib/account-file-store"
import {
  getAccountProvider,
  getCodebuffAuthToken,
  getGitHubToken,
  getMimoPh,
  getMimoServiceToken,
  getWindsurfApiKey,
} from "~/lib/accounts"
import { GITHUB_API_BASE_URL, githubApiHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { isOAuthProviderId, isProviderId } from "~/lib/provider-config"
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

function defaultProvider(provider?: AccountProvider): AccountProvider {
  return provider ?? "copilot"
}

export async function loadAccounts(): Promise<void> {
  return accountsLifecycleMutex.runExclusive(async () => {
    await loadAccountsUnlocked()
  })
}

async function loadAccountsUnlocked(): Promise<void> {
  clearAllAccountTimers()
  cancelAllOAuthRefreshTimers()
  const accountFile = await tryReadAccountsFile()
  if (accountFile.status === "found") {
    const rawAccounts = accountFile.accounts
    const loadedAccounts: Array<Account> = []
    let migratedLegacyShape = false
    for (const raw of rawAccounts) {
      if (accountHasLegacyFlatFields(raw)) {
        migratedLegacyShape = true
      }
      try {
        loadedAccounts.push(migrateAccount(raw))
      } catch (err) {
        logger.warn(`Skipping invalid account entry: ${(err as Error).message}`)
      }
    }
    state.accounts = loadedAccounts
    if (loadedAccounts.length === 0) {
      logger.warn("No accounts loaded from disk")
    } else {
      logger.info(
        `Loaded ${loadedAccounts.length} account(s) from disk: ${loadedAccounts.map((account) => account.label).join(", ")}`,
      )
    }
    for (const account of state.accounts) {
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
    if (migratedLegacyShape) {
      await saveAccountsUnlocked()
      logger.info("Persisted migrated account schema to accounts.json")
    }
    scheduleOAuthRefreshForAllAccounts()
    return
  }

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
      state.accounts = [account]
      state.activeAccountIndex = 0
      await saveAccountsUnlocked()
      logger.info("Migrated legacy GitHub token to accounts.json")
      return
    }
  } catch {
    // No legacy token file either
  }

  state.accounts = []
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
    if (state.accounts.length === 0) return
    const sanitized = state.accounts.map((account) => serializeAccount(account))
    if (!(await writeAccountsFile(sanitized, { allowShrink: true }))) {
      logger.error("Shutdown account flush skipped by write guards")
    }
  })
}

async function saveAccountsUnlocked(
  options: SaveAccountsOptions = {},
): Promise<void> {
  if (state.accounts.length === 0 && !options.allowEmpty) {
    const diskHasData = await accountsDiskHasRecoverableData()
    if (diskHasData) {
      logger.warn(
        "Refusing to persist empty accounts snapshot while existing accounts data is on disk",
      )
      return
    }
  }

  const sanitized = state.accounts.map((account) => serializeAccount(account))
  await writeAccountsFile(sanitized, {
    allowEmpty: options.allowEmpty,
    allowShrink: options.allowShrink,
  })
  // 持久化完成后通知 models-stale,触发 cacheModels() 重建缓存
  emitStateChange("models-stale")
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
  const account = state.accounts.find((a) => a.id === accountId)
  if (!account || !account.enabled) {
    tokenRefreshTimers.delete(accountId)
    return
  }
  logger.warn(
    `Scheduling token refresh retry for account "${accountId}" in ${TOKEN_REFRESH_RETRY_DELAY_MS / 1000}s`,
  )
  const retryTimerId = setTimeout(() => {
    const currentAccount = state.accounts.find((a) => a.id === accountId)
    if (!currentAccount || !currentAccount.enabled) {
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

  const githubToken =
    (account.credentials?.githubToken as string | undefined) ?? undefined
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

  account.runtimeState = {
    ...account.runtimeState,
    copilotToken: data.token,
    copilotTokenExpiry: data.expires_at * 1000,
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
    const currentAccount = state.accounts.find((a) => a.id === accountId)
    if (!currentAccount || !currentAccount.enabled) {
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
  for (const account of state.accounts) {
    cancelTokenRefreshTimer(account.id)
  }
}

export async function initAccounts(): Promise<void> {
  await loadAccounts()
}

function migrateAccount(account: Record<string, unknown>): Account {
  const acc = migrateAccountInternal(account)
  if (typeof account.cooldownUntil === "number") {
    acc.cooldownUntil = account.cooldownUntil
  } else if (typeof account.cooldownUntil === "string") {
    const parsed = Date.parse(account.cooldownUntil)
    if (!Number.isNaN(parsed)) {
      acc.cooldownUntil = parsed
    }
  }
  return acc
}

type LegacyAccountRecord = Record<string, unknown> & {
  isActive?: boolean
  enabled?: boolean
  priority?: number
  provider?: AccountProvider
  githubToken?: string
  copilotToken?: string
  copilotTokenExpiry?: number
  codebuffAuthToken?: string
  codebuffBaseUrl?: string
  codebuffCliVersion?: string
  codebuffAgentId?: string
  codebuffModel?: string
  codebuffCostMode?: string
  codebuffAllowFallbacks?: boolean
  windsurfApiKey?: string
  windsurfBaseUrl?: string
  windsurfAppVersion?: string
  windsurfLsVersion?: string
  windsurfDefaultModel?: string
  windsurfClientName?: string
  windsurfJwt?: string
  windsurfJwtFetchedAt?: number
  serviceToken?: string
  xiaomichatbotPh?: string
  mimoWsToken?: string
  userId?: string
  proxy?: string
  quotaState?: AccountQuotaState
  quotaExhaustedAt?: number
}

const LEGACY_FLAT_FIELD_KEYS = [
  "githubToken",
  "copilotToken",
  "copilotTokenExpiry",
  "codebuffAuthToken",
  "codebuffBaseUrl",
  "codebuffCliVersion",
  "codebuffAgentId",
  "codebuffModel",
  "codebuffCostMode",
  "codebuffAllowFallbacks",
  "windsurfApiKey",
  "windsurfBaseUrl",
  "windsurfAppVersion",
  "windsurfLsVersion",
  "windsurfDefaultModel",
  "windsurfClientName",
  "windsurfJwt",
  "windsurfJwtFetchedAt",
  "serviceToken",
  "xiaomichatbotPh",
  "mimoWsToken",
  "userId",
  "proxy",
] as const

function accountHasLegacyFlatFields(account: Record<string, unknown>): boolean {
  return LEGACY_FLAT_FIELD_KEYS.some((key) => key in account)
}

type MigratedAccountBase = Omit<
  Account,
  "provider" | "credentials" | "settings" | "runtimeState"
>

function pickString(primary: unknown, fallback: unknown): string | undefined {
  if (typeof primary === "string") {
    return primary
  }
  if (typeof fallback === "string") {
    return fallback
  }
  return undefined
}

function pickNumber(primary: unknown, fallback: unknown): number | undefined {
  if (typeof primary === "number") {
    return primary
  }
  if (typeof fallback === "number") {
    return fallback
  }
  return undefined
}

function pickBoolean(primary: unknown, fallback: unknown): boolean | undefined {
  if (typeof primary === "boolean") {
    return primary
  }
  if (typeof fallback === "boolean") {
    return fallback
  }
  return undefined
}

function normalizeLegacyAccount(
  account: Record<string, unknown>,
): LegacyAccountRecord & Partial<Account> {
  const acc = account as LegacyAccountRecord & Partial<Account>

  if (typeof acc.enabled !== "boolean" && typeof acc.isActive === "boolean") {
    acc.enabled = acc.isActive
    logger.debug(
      `Migrated account "${acc.label}" isActive → enabled: ${acc.enabled}`,
    )
  }

  if (typeof acc.enabled !== "boolean") {
    acc.enabled = true
  }

  if (typeof acc.priority !== "number") {
    acc.priority = 0
  }

  if (!isProviderId(String(acc.provider))) {
    acc.provider = "copilot"
  }

  if (
    acc.quotaState !== "available"
    && acc.quotaState !== "exhausted"
    && acc.quotaState !== "unknown"
  ) {
    acc.quotaState = "unknown"
  }

  return acc
}

function buildMigratedAccountBase(
  acc: LegacyAccountRecord & Partial<Account>,
): MigratedAccountBase {
  return {
    id: String(acc.id),
    label: String(acc.label),
    enabled: acc.enabled ?? true,
    priority: acc.priority ?? 0,
    quotaState: acc.quotaState ?? "unknown",
    quotaExhaustedAt: acc.quotaExhaustedAt,
    availableModels: acc.availableModels,
    quotaInfo: acc.quotaInfo,
    cooldownUntil: acc.cooldownUntil,
    isExhausted: acc.isExhausted,
    exhaustedAt: acc.exhaustedAt,
    lastRateLimitAt: acc.lastRateLimitAt,
    lastRateLimitReason: acc.lastRateLimitReason,
    createdAt: typeof acc.createdAt === "number" ? acc.createdAt : Date.now(),
  }
}

function migrateCopilotAccount(
  base: MigratedAccountBase,
  acc: LegacyAccountRecord,
  existingCredentials: Record<string, unknown> | undefined,
  existingSettings: Record<string, unknown> | undefined,
  existingRuntime: AccountRuntimeState | undefined,
): Account {
  return {
    ...base,
    provider: "copilot",
    credentials: {
      githubToken: pickString(
        existingCredentials?.githubToken,
        acc.githubToken,
      ),
    },
    settings: existingSettings ?? {},
    runtimeState: {
      ...existingRuntime,
      copilotToken: pickString(existingRuntime?.copilotToken, acc.copilotToken),
      copilotTokenExpiry: pickNumber(
        existingRuntime?.copilotTokenExpiry,
        acc.copilotTokenExpiry,
      ),
    },
  }
}

function migrateCodebuffAccount(
  base: MigratedAccountBase,
  acc: LegacyAccountRecord,
  existingCredentials: Record<string, unknown> | undefined,
  existingSettings: Record<string, unknown> | undefined,
  existingRuntime: AccountRuntimeState | undefined,
): Account {
  return {
    ...base,
    provider: "codebuff",
    credentials: {
      authToken: pickString(
        existingCredentials?.authToken,
        acc.codebuffAuthToken,
      ),
    },
    settings: {
      baseUrl: pickString(existingSettings?.baseUrl, acc.codebuffBaseUrl),
      cliVersion: pickString(
        existingSettings?.cliVersion,
        acc.codebuffCliVersion,
      ),
      agentId: pickString(existingSettings?.agentId, acc.codebuffAgentId),
      model: pickString(existingSettings?.model, acc.codebuffModel),
      costMode: pickString(existingSettings?.costMode, acc.codebuffCostMode),
      allowFallbacks: pickBoolean(
        existingSettings?.allowFallbacks,
        acc.codebuffAllowFallbacks,
      ),
    },
    runtimeState: existingRuntime,
  }
}

function migrateWindsurfAccount(
  base: MigratedAccountBase,
  acc: LegacyAccountRecord,
  existingCredentials: Record<string, unknown> | undefined,
  existingSettings: Record<string, unknown> | undefined,
  existingRuntime: AccountRuntimeState | undefined,
): Account {
  return {
    ...base,
    provider: "windsurf",
    credentials: {
      apiKey: pickString(existingCredentials?.apiKey, acc.windsurfApiKey),
    },
    settings: {
      baseUrl: pickString(existingSettings?.baseUrl, acc.windsurfBaseUrl),
      appVersion: pickString(
        existingSettings?.appVersion,
        acc.windsurfAppVersion,
      ),
      lsVersion: pickString(existingSettings?.lsVersion, acc.windsurfLsVersion),
      defaultModel: pickString(
        existingSettings?.defaultModel,
        acc.windsurfDefaultModel,
      ),
      clientName: pickString(
        existingSettings?.clientName,
        acc.windsurfClientName,
      ),
    },
    runtimeState: {
      ...existingRuntime,
      windsurfJwt: pickString(existingRuntime?.windsurfJwt, acc.windsurfJwt),
      windsurfJwtFetchedAt: pickNumber(
        existingRuntime?.windsurfJwtFetchedAt,
        acc.windsurfJwtFetchedAt,
      ),
    },
  }
}

function migrateMimoAccount(
  base: MigratedAccountBase,
  acc: LegacyAccountRecord,
  existingCredentials: Record<string, unknown> | undefined,
  existingSettings: Record<string, unknown> | undefined,
  existingRuntime: AccountRuntimeState | undefined,
): Account {
  return {
    ...base,
    provider: "mimo-aistudio",
    credentials: {
      serviceToken: pickString(
        existingCredentials?.serviceToken,
        acc.serviceToken,
      ),
      xiaomichatbotPh: pickString(
        existingCredentials?.xiaomichatbotPh,
        acc.xiaomichatbotPh,
      ),
      mimoWsToken: pickString(
        existingCredentials?.mimoWsToken,
        acc.mimoWsToken,
      ),
    },
    settings: {
      userId: pickString(existingSettings?.userId, acc.userId),
      proxy: pickString(existingSettings?.proxy, acc.proxy),
    },
    runtimeState: existingRuntime,
  }
}

interface MigrateOAuthAccountInput {
  base: MigratedAccountBase
  provider: OAuthProviderId
  existingCredentials?: Record<string, unknown>
  existingSettings?: Record<string, unknown>
  existingRuntime?: AccountRuntimeState
  cpaMetadata?: Record<string, unknown>
}

function migrateOAuthAccount(input: MigrateOAuthAccountInput): Account {
  const {
    base,
    provider,
    existingCredentials,
    existingSettings,
    existingRuntime,
    cpaMetadata,
  } = input
  return {
    ...base,
    provider,
    credentials: {
      accessToken: pickString(existingCredentials?.accessToken, undefined),
      refreshToken: pickString(existingCredentials?.refreshToken, undefined),
      idToken: pickString(existingCredentials?.idToken, undefined),
      expiresAt: pickNumber(existingCredentials?.expiresAt, undefined),
      accountId: pickString(existingCredentials?.accountId, undefined),
      projectId: pickString(existingCredentials?.projectId, undefined),
      deviceId: pickString(existingCredentials?.deviceId, undefined),
      apiKey: pickString(existingCredentials?.apiKey, undefined),
      email: pickString(existingCredentials?.email, undefined),
    },
    settings: {
      baseUrl: pickString(existingSettings?.baseUrl, undefined),
      proxyUrl: pickString(existingSettings?.proxyUrl, undefined),
      modelPrefix: pickString(existingSettings?.modelPrefix, undefined),
      cpaSourcePath: pickString(existingSettings?.cpaSourcePath, undefined),
      tokenEndpoint: pickString(existingSettings?.tokenEndpoint, undefined),
      redirectUri: pickString(existingSettings?.redirectUri, undefined),
    },
    runtimeState: existingRuntime,
    cpaMetadata,
  }
}

function migrateAccountInternal(account: Record<string, unknown>): Account {
  const acc = normalizeLegacyAccount(account)
  const base = buildMigratedAccountBase(acc)
  const existingCredentials = acc.credentials
  const existingSettings = acc.settings
  const existingRuntime = acc.runtimeState
  const provider = defaultProvider(acc.provider)

  if (provider === "copilot") {
    return migrateCopilotAccount(
      base,
      acc,
      existingCredentials,
      existingSettings,
      existingRuntime,
    )
  }

  if (provider === "codebuff") {
    return migrateCodebuffAccount(
      base,
      acc,
      existingCredentials,
      existingSettings,
      existingRuntime,
    )
  }

  if (provider === "windsurf") {
    return migrateWindsurfAccount(
      base,
      acc,
      existingCredentials,
      existingSettings,
      existingRuntime,
    )
  }

  if (isOAuthProviderId(provider)) {
    return migrateOAuthAccount({
      base,
      provider,
      existingCredentials,
      existingSettings,
      existingRuntime,
      cpaMetadata: acc.cpaMetadata,
    })
  }

  return migrateMimoAccount(
    base,
    acc,
    existingCredentials,
    existingSettings,
    existingRuntime,
  )
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
  account.quotaInfo = snapshotFromUsage(usage)
  const remaining = account.quotaInfo.premiumInteractionsRemaining ?? Infinity
  const unlimited = account.quotaInfo.unlimited
  const exhausted = !unlimited && remaining <= QUOTA_EXHAUSTION_THRESHOLD

  if (exhausted) {
    if (account.quotaState !== "exhausted") {
      setAccountQuotaState(account, "exhausted")
      logger.warn(`Account "${account.label}" quota exhausted`)
    }
  } else {
    if (account.quotaState === "exhausted") {
      logger.info(`Account "${account.label}" quota refreshed — re-activating`)
    }
    setAccountQuotaState(account, "available")
  }
  if (!skipSave) {
    await saveAccounts()
  }
}

async function refreshAllQuotas(): Promise<void> {
  const results = await Promise.allSettled(
    state.accounts.map((account) => refreshQuotaForAccount(account, true)),
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
  const githubToken =
    (account.credentials?.githubToken as string | undefined) ?? undefined
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
