import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type {
  Account,
  AccountProvider,
  AccountQuotaState,
  CodebuffAccount,
  CopilotAccount,
  WindsurfAccount,
  MimoAccount,
} from "~/lib/accounts"

import {
  syncLegacyExhaustedState,
  setAccountQuotaState,
} from "~/lib/account-availability"
import {
  getAccountProvider,
  getCodebuffAuthToken,
  getGitHubToken,
  getWindsurfApiKey,
  getMimoServiceToken,
  getMimoPh,
  setCopilotToken,
  setCopilotTokenExpiry,
} from "~/lib/accounts"
import { GITHUB_API_BASE_URL, githubApiHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { isProviderId } from "~/lib/provider-config"
import { state } from "~/lib/state"

const QUOTA_EXHAUSTION_THRESHOLD = 5
const QUOTA_RECHECK_INTERVAL_MS = 5 * 60 * 1000
const TOKEN_REFRESH_RETRY_DELAY_MS = 60_000

const tokenRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

function defaultProvider(provider?: AccountProvider): AccountProvider {
  return provider ?? "copilot"
}

export async function loadAccounts(): Promise<void> {
  clearAllAccountTimers()
  const rawAccounts = await tryReadAccountsFile()
  if (rawAccounts.length > 0) {
    state.accounts = []
    let migratedLegacyShape = false
    for (const raw of rawAccounts) {
      if (accountHasLegacyFlatFields(raw)) {
        migratedLegacyShape = true
      }
      try {
        state.accounts.push(migrateAccount(raw))
      } catch (err) {
        consola.warn(
          `Skipping invalid account entry: ${(err as Error).message}`,
        )
      }
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
      await saveAccounts()
      consola.info("Persisted migrated account schema to accounts.json")
    }
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
      await saveAccounts()
      consola.info("Migrated legacy GitHub token to accounts.json")
      return
    }
  } catch {
    // No legacy token file either
  }

  state.accounts = []
}

async function tryReadAccountsFile(): Promise<Array<Record<string, unknown>>> {
  try {
    return await readAccountsFile(PATHS.ACCOUNTS_PATH)
  } catch {
    return []
  }
}

class Mutex {
  private queue: Promise<void> = Promise.resolve()

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: (() => void) | undefined
    const next = new Promise<void>((r) => {
      resolve = r
    })
    const prev = this.queue
    this.queue = next

    try {
      await prev
      return await fn()
    } finally {
      resolve?.()
    }
  }
}

const fileMutex = new Mutex()

export async function saveAccounts(): Promise<void> {
  const targetPath = PATHS.ACCOUNTS_PATH
  const appDir = PATHS.APP_DIR
  return fileMutex.runExclusive(async () => {
    const sanitized = state.accounts.map((account) => serializeAccount(account))
    const tmpPath = `${targetPath}.${process.pid}.tmp`
    try {
      await fs.mkdir(appDir, { recursive: true })
      await fs.writeFile(tmpPath, JSON.stringify(sanitized, null, 2), "utf8")
      await fs.rename(tmpPath, targetPath)
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {})
      throw error
    }
  })
}

export function serializeAccountForExport(
  account: Account,
): Record<string, unknown> {
  return serializeAccount(account)
}

function serializeAccount(account: Account): Record<string, unknown> {
  syncLegacyExhaustedState(account)
  const base = {
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
  consola.warn(
    `Scheduling token refresh retry for account "${accountId}" in ${TOKEN_REFRESH_RETRY_DELAY_MS / 1000}s`,
  )
  const retryTimerId = setTimeout(() => {
    const currentAccount = state.accounts.find((a) => a.id === accountId)
    if (!currentAccount || !currentAccount.enabled) {
      tokenRefreshTimers.delete(accountId)
      return
    }
    refreshCopilotToken(currentAccount).catch((error: unknown) => {
      consola.error(
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

  setCopilotToken(account, data.token)
  setCopilotTokenExpiry(account, data.expires_at * 1000)

  if (state.showToken) {
    consola.info(`Copilot token for "${account.label}":`, data.token)
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

    consola.debug(`Refreshing Copilot token for "${currentAccount.label}"`)
    refreshCopilotToken(currentAccount).catch((error: unknown) => {
      consola.error(
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
    consola.debug(`Cancelled token refresh timer for account "${accountId}"`)
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
    consola.debug(
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
  existingRuntime: Account["runtimeState"],
): CopilotAccount {
  return {
    ...base,
    provider: "copilot",
    credentials: {
      githubToken: pickString(
        existingCredentials?.githubToken,
        acc.githubToken,
      ),
    },
    settings: (existingSettings as CopilotAccount["settings"]) ?? {},
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
  existingRuntime: Account["runtimeState"],
): CodebuffAccount {
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
  existingRuntime: Account["runtimeState"],
): WindsurfAccount {
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
  existingRuntime: Account["runtimeState"],
): MimoAccount {
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

function migrateAccountInternal(account: Record<string, unknown>): Account {
  const acc = normalizeLegacyAccount(account)
  const base = buildMigratedAccountBase(acc)
  const existingCredentials = acc.credentials as
    | Record<string, unknown>
    | undefined
  const existingSettings = acc.settings as Record<string, unknown> | undefined
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

  return migrateMimoAccount(
    base,
    acc,
    existingCredentials,
    existingSettings,
    existingRuntime,
  )
}

async function readAccountsFile(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  return fileMutex.runExclusive(async () => {
    const data = await fs.readFile(path)
    return JSON.parse(data.toString("utf8")) as Array<Record<string, unknown>>
  })
}

export function scheduleQuotaRefresh(): void {
  void refreshAllQuotas()
  setInterval(() => {
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
      consola.warn(`Account "${account.label}" quota exhausted`)
    }
  } else {
    if (account.quotaState === "exhausted") {
      consola.info(`Account "${account.label}" quota refreshed — re-activating`)
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
      consola.warn("Failed to refresh quota for account:", result.reason)
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
