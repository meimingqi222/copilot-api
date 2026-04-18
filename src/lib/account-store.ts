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
  setCopilotToken,
  setCopilotTokenExpiry,
} from "~/lib/accounts"
import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
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
  try {
    const raw = await readAccountsFile(PATHS.ACCOUNTS_PATH)
    state.accounts = raw.map((account) => migrateAccount(account))
    for (const account of state.accounts) {
      account.cooldownUntil = undefined
      account.lastRateLimitAt = undefined
      account.lastRateLimitReason = undefined
      syncLegacyExhaustedState(account)
    }
    return
  } catch {
    // File doesn't exist or is invalid — migrate from legacy token
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
        githubToken: legacyToken.trim(),
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

export async function saveAccounts(): Promise<void> {
  const sanitized = state.accounts.map((account) => serializeAccount(account))
  await fs.writeFile(PATHS.ACCOUNTS_PATH, JSON.stringify(sanitized, null, 2))
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
      settings: account.settings ?? {
        baseUrl: account.codebuffBaseUrl,
        cliVersion: account.codebuffCliVersion,
        agentId: account.codebuffAgentId,
        model: account.codebuffModel,
        costMode: account.codebuffCostMode,
        allowFallbacks: account.codebuffAllowFallbacks,
      },
    }
  }

  return {
    ...base,
    credentials: {
      apiKey: getWindsurfApiKey(account),
    },
    settings: account.settings ?? {
      baseUrl: account.windsurfBaseUrl,
      appVersion: account.windsurfAppVersion,
      lsVersion: account.windsurfLsVersion,
      defaultModel: account.windsurfDefaultModel,
      clientName: account.windsurfClientName,
    },
  }
}

function scheduleTokenRefreshRetry(accountId: string): void {
  consola.warn(
    `Scheduling token refresh retry for account "${accountId}" in ${TOKEN_REFRESH_RETRY_DELAY_MS / 1000}s`,
  )
  const retryTimerId = setTimeout(() => {
    const account = state.accounts.find((a) => a.id === accountId)
    if (!account) {
      tokenRefreshTimers.delete(accountId)
      return
    }
    refreshCopilotToken(account).catch((error: unknown) => {
      consola.error(`Token refresh retry failed for "${account.label}":`, error)
      scheduleTokenRefreshRetry(accountId)
    })
  }, TOKEN_REFRESH_RETRY_DELAY_MS)
  tokenRefreshTimers.set(accountId, retryTimerId)
}

export async function refreshCopilotToken(account: Account): Promise<void> {
  if (getAccountProvider(account) !== "copilot") {
    return
  }

  const githubToken = getGitHubToken(account)
  if (!githubToken) {
    throw new Error(`GitHub token missing for account "${account.label}"`)
  }

  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: {
        ...githubHeaders(state),
        authorization: `token ${githubToken}`,
      },
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot token for account", response)
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
    if (!currentAccount) {
      consola.warn(
        `Account "${accountId}" not found during token refresh, cancelling timer`,
      )
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

export async function initAccounts(tokens?: Array<string>): Promise<void> {
  if (tokens && tokens.length > 0) {
    const existing = await loadAccountsFile()
    const newAccounts: Array<Account> = tokens.map((token, index) => {
      const existingAccount = existing.find(
        (account) =>
          account.provider === "copilot" && getGitHubToken(account) === token,
      )
      if (existingAccount) {
        return existingAccount
      }
      return {
        id: randomUUID(),
        label: index === 0 ? "default" : `account-${index + 1}`,
        provider: "copilot",
        credentials: {
          githubToken: token,
        },
        settings: {},
        githubToken: token,
        enabled: true,
        priority: 0,
        quotaState: "unknown",
        createdAt: Date.now(),
      }
    })
    state.accounts = newAccounts
    state.activeAccountIndex = 0
    await saveAccounts()
  } else {
    await loadAccounts()
  }

  const active = state.accounts[state.activeAccountIndex] as Account | undefined
  state.githubToken =
    active && getAccountProvider(active) === "copilot" ?
      getGitHubToken(active)
    : undefined
}

// eslint-disable-next-line complexity, max-lines-per-function
function migrateAccount(account: Record<string, unknown>): Account {
  const acc = account as Record<string, unknown>
    & Partial<Account> & {
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
      quotaState?: AccountQuotaState
      quotaExhaustedAt?: number
    }

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

  delete acc.isActive

  const provider = defaultProvider(acc.provider)

  if (provider === "copilot") {
    const githubToken =
      typeof acc.githubToken === "string" ? acc.githubToken : undefined
    const copilotToken =
      typeof acc.copilotToken === "string" ? acc.copilotToken : undefined
    const copilotTokenExpiry =
      typeof acc.copilotTokenExpiry === "number" ?
        acc.copilotTokenExpiry
      : undefined

    return {
      ...(acc as Partial<CopilotAccount>),
      provider,
      credentials: {
        githubToken:
          (acc as Partial<CopilotAccount>).credentials?.githubToken
          ?? githubToken,
      },
      settings: (acc as Partial<CopilotAccount>).settings ?? {},
      githubToken,
      copilotToken,
      copilotTokenExpiry,
      runtimeState: {
        ...acc.runtimeState,
        copilotToken,
        copilotTokenExpiry,
      },
      quotaState: acc.quotaState,
      quotaExhaustedAt: acc.quotaExhaustedAt,
    } as CopilotAccount
  }

  if (provider === "codebuff") {
    const authToken =
      typeof acc.codebuffAuthToken === "string" ?
        acc.codebuffAuthToken
      : undefined
    return {
      ...(acc as Partial<CodebuffAccount>),
      provider,
      credentials: {
        authToken:
          (acc as Partial<CodebuffAccount>).credentials?.authToken ?? authToken,
      },
      settings: (acc as Partial<CodebuffAccount>).settings ?? {
        baseUrl: acc.codebuffBaseUrl,
        cliVersion: acc.codebuffCliVersion,
        agentId: acc.codebuffAgentId,
        model: acc.codebuffModel,
        costMode: acc.codebuffCostMode,
        allowFallbacks: acc.codebuffAllowFallbacks,
      },
      quotaState: acc.quotaState,
      quotaExhaustedAt: acc.quotaExhaustedAt,
    } as CodebuffAccount
  }

  const apiKey =
    typeof acc.windsurfApiKey === "string" ? acc.windsurfApiKey : undefined

  return {
    ...(acc as Partial<WindsurfAccount>),
    provider,
    credentials: {
      apiKey: (acc as Partial<WindsurfAccount>).credentials?.apiKey ?? apiKey,
    },
    settings: (acc as Partial<WindsurfAccount>).settings ?? {
      baseUrl: acc.windsurfBaseUrl,
      appVersion: acc.windsurfAppVersion,
      lsVersion: acc.windsurfLsVersion,
      defaultModel: acc.windsurfDefaultModel,
      clientName: acc.windsurfClientName,
    },
    quotaState: acc.quotaState,
    quotaExhaustedAt: acc.quotaExhaustedAt,
  } as WindsurfAccount
}

async function loadAccountsFile(): Promise<Array<Account>> {
  try {
    return (await readAccountsFile(PATHS.ACCOUNTS_PATH)).map((account) =>
      migrateAccount(account),
    )
  } catch {
    return []
  }
}

async function readAccountsFile(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  const data = await fs.readFile(path)
  return JSON.parse(data.toString("utf8")) as Array<Record<string, unknown>>
}

export function scheduleQuotaRefresh(): void {
  void refreshAllQuotas()
  setInterval(() => {
    void refreshAllQuotas()
  }, QUOTA_RECHECK_INTERVAL_MS)
}

export async function refreshQuotaForAccount(account: Account): Promise<void> {
  if (getAccountProvider(account) !== "copilot") {
    return
  }

  const usage = await getCopilotUsageForAccount(account)
  // eslint-disable-next-line require-atomic-updates
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
  await saveAccounts()
}

async function refreshAllQuotas(): Promise<void> {
  for (const account of state.accounts) {
    try {
      await refreshQuotaForAccount(account)
    } catch (err) {
      consola.warn(
        `Failed to refresh quota for account "${account.label}":`,
        err,
      )
    }
  }
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
      ...githubHeaders(state),
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
