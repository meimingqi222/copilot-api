import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

export interface Account {
  id: string
  label: string
  githubToken: string
  copilotToken?: string
  copilotTokenExpiry?: number
  quotaInfo?: QuotaSnapshot
  availableModels?: Array<string>
  enabled: boolean // 用户控制是否启用(参与负载均衡)
  isExhausted: boolean
  exhaustedAt?: number
  createdAt: number
}

export interface QuotaSnapshot {
  fetchedAt: number
  premiumInteractionsRemaining?: number
  premiumInteractionsTotal?: number
  chatRemaining?: number
  chatTotal?: number
  completionsRemaining?: number
  completionsTotal?: number
  unlimited: boolean
}

const QUOTA_EXHAUSTION_THRESHOLD = 5
const QUOTA_RECHECK_INTERVAL_MS = 5 * 60 * 1000

// Map to store token refresh timers for cleanup on account deletion
const tokenRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export async function loadAccounts(): Promise<void> {
  try {
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    const data = await fs.readFile(PATHS.ACCOUNTS_PATH, "utf8")
    const raw = JSON.parse(data) as Array<Record<string, unknown>>
    // Apply migration to handle old accounts with isActive instead of enabled
    state.accounts = raw.map((account) => migrateAccount(account))
    return
  } catch {
    // File doesn't exist or is invalid — migrate from legacy token
  }

  // Migrate from legacy github_token file
  try {
    const legacyToken = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
    if (legacyToken.trim()) {
      const account: Account = {
        id: randomUUID(),
        label: "default",
        githubToken: legacyToken.trim(),
        enabled: true,
        isExhausted: false,
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
  // Exclude ephemeral copilotToken from persistent storage
  const sanitized = state.accounts.map(
    ({ copilotToken: _ct, copilotTokenExpiry: _cte, ...rest }) => rest,
  )
  await fs.writeFile(PATHS.ACCOUNTS_PATH, JSON.stringify(sanitized, null, 2))
}

/**
 * Get an account that supports the given model, preferring the currently active account.
 * Falls back to the first available account that supports the model.
 * If no account specifies model support (availableModels is undefined), any enabled/non-exhausted account works.
 */
export function getAccountForModel(modelId: string): Account {
  const available = state.accounts.filter((a) => a.enabled && !a.isExhausted)
  if (available.length === 0) {
    throw new HTTPError(
      "No available GitHub Copilot accounts (all disabled or quota-exhausted)",
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  // Accounts that support the model (or have no model restriction)
  const capable = available.filter(
    (a) => !a.availableModels || a.availableModels.includes(modelId),
  )

  if (capable.length === 0) {
    throw new HTTPError(
      `No available account supports model "${modelId}"`,
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  // Prefer current active account if it supports the model
  const preferred = state.accounts[state.activeAccountIndex] as
    | Account
    | undefined

  if (
    preferred
    && preferred.enabled
    && !preferred.isExhausted
    && (!preferred.availableModels
      || preferred.availableModels.includes(modelId))
  ) {
    state.githubToken = preferred.githubToken
    return preferred
  }

  // Otherwise pick first capable account
  const next = capable[0]
  state.activeAccountIndex = state.accounts.indexOf(next)
  state.githubToken = next.githubToken
  return next
}

/**
 * Switch to next account that supports the given model.
 */
export function switchToNextAccountForModel(
  currentAccount: Account,
  modelId: string,
): Account | null {
  const total = state.accounts.length
  const currentIdx = state.accounts.indexOf(currentAccount)
  for (let i = 1; i <= total; i++) {
    const idx = (currentIdx + i) % total
    const account = state.accounts[idx]
    if (
      account.enabled
      && !account.isExhausted
      && (!account.availableModels || account.availableModels.includes(modelId))
    ) {
      state.activeAccountIndex = idx
      state.githubToken = account.githubToken
      consola.info(
        `Switched to account "${account.label}" for model "${modelId}"`,
      )
      return account
    }
  }
  return null
}

export function getActiveAccount(): Account {
  // 只考虑已启用且未耗尽的账户
  const available = state.accounts.filter((a) => a.enabled && !a.isExhausted)
  if (available.length === 0) {
    throw new HTTPError(
      "No available GitHub Copilot accounts (all disabled or quota-exhausted)",
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  const preferred = state.accounts[state.activeAccountIndex]
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (preferred && preferred.enabled && !preferred.isExhausted) {
    // Sync state.githubToken for backward compat
    state.githubToken = preferred.githubToken
    return preferred
  }

  const next = available[0]
  state.activeAccountIndex = state.accounts.indexOf(next)
  // Sync state.githubToken for backward compat
  state.githubToken = next.githubToken
  return next
}

export function markAccountExhausted(id: string): void {
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return
  if (account.isExhausted) return
  account.isExhausted = true
  account.exhaustedAt = Date.now()
  consola.warn(`Account "${account.label}" marked as quota-exhausted`)
  switchToNextAccount()
}

export function switchToNextAccount(): Account | null {
  const total = state.accounts.length
  for (let i = 1; i <= total; i++) {
    const idx = (state.activeAccountIndex + i) % total
    const account = state.accounts[idx]
    // 只切换到已启用且未耗尽的账户
    if (account.enabled && !account.isExhausted) {
      state.activeAccountIndex = idx
      // Sync state.githubToken for backward compat
      state.githubToken = account.githubToken
      consola.info(`Switched to account "${account.label}"`)
      return account
    }
  }
  return null
}

export async function refreshCopilotToken(account: Account): Promise<void> {
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: {
        ...githubHeaders(state),
        authorization: `token ${account.githubToken}`,
      },
    },
  )

  if (!response.ok)
    throw new HTTPError("Failed to get Copilot token for account", response)

  const data = (await response.json()) as {
    token: string
    expires_at: number
    refresh_in: number
  }

  // eslint-disable-next-line require-atomic-updates
  account.copilotToken = data.token
  // eslint-disable-next-line require-atomic-updates
  account.copilotTokenExpiry = data.expires_at * 1000

  if (state.showToken) {
    consola.info(`Copilot token for "${account.label}":`, data.token)
  }

  // Schedule token refresh (ensure minimum 60s interval to prevent rapid calls)
  const refreshInterval = Math.max((data.refresh_in - 60) * 1000, 60_000)

  // Clear any existing timer for this account
  const existingTimer = tokenRefreshTimers.get(account.id)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const timerId = setTimeout(() => {
    consola.debug(`Refreshing Copilot token for "${account.label}"`)
    refreshCopilotToken(account).catch((error: unknown) => {
      consola.error(
        `Failed to refresh Copilot token for "${account.label}":`,
        error,
      )
    })
  }, refreshInterval)

  tokenRefreshTimers.set(account.id, timerId)
}

/**
 * Cancels the pending token refresh timer for an account.
 * Should be called when an account is deleted to prevent timer leaks.
 */
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
    // Build accounts from provided tokens
    const existing = await loadAccountsFile()
    const newAccounts: Array<Account> = tokens.map((token, index) => {
      const existingAccount = existing.find((a) => a.githubToken === token)
      if (existingAccount) return existingAccount
      return {
        id: randomUUID(),
        label: index === 0 ? "default" : `account-${index + 1}`,
        githubToken: token,
        enabled: true,
        isExhausted: false,
        createdAt: Date.now(),
      }
    })
    state.accounts = newAccounts
    state.activeAccountIndex = 0
    await saveAccounts()
  } else {
    await loadAccounts()
  }

  // Sync state.githubToken for backward compat
  const active = state.accounts[state.activeAccountIndex] as Account | undefined
  state.githubToken = active?.githubToken
}

// Migrate old isActive field to enabled field for backward compatibility
function migrateAccount(account: Record<string, unknown>): Account {
  const acc = account as Partial<Account> & {
    isActive?: boolean
    enabled?: boolean
  }

  // Migrate isActive → enabled (if enabled not set but isActive is, use isActive)
  if (typeof acc.enabled !== "boolean" && typeof acc.isActive === "boolean") {
    acc.enabled = acc.isActive
    consola.debug(
      `Migrated account "${acc.label}" isActive → enabled: ${acc.enabled}`,
    )
  }

  // Default enabled to true if neither field exists
  if (typeof acc.enabled !== "boolean") {
    acc.enabled = true
  }

  // Clean up old field
  delete acc.isActive

  return acc as Account
}

async function loadAccountsFile(): Promise<Array<Account>> {
  try {
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    const data = await fs.readFile(PATHS.ACCOUNTS_PATH, "utf8")
    const raw = JSON.parse(data) as Array<Record<string, unknown>>
    // Apply migration to handle old accounts with isActive instead of enabled
    return raw.map((account) => migrateAccount(account))
  } catch {
    return []
  }
}

export function scheduleQuotaRefresh(): void {
  // Run an immediate quota check to clear any stale isExhausted flags from a previous run
  void refreshAllQuotas()
  setInterval(() => {
    void refreshAllQuotas()
  }, QUOTA_RECHECK_INTERVAL_MS)
}

export async function refreshQuotaForAccount(account: Account): Promise<void> {
  const usage = await getCopilotUsageForAccount(account)
  // eslint-disable-next-line require-atomic-updates
  account.quotaInfo = snapshotFromUsage(usage)
  const remaining = account.quotaInfo.premiumInteractionsRemaining ?? Infinity
  const unlimited = account.quotaInfo.unlimited

  if (
    account.isExhausted
    && (unlimited || remaining > QUOTA_EXHAUSTION_THRESHOLD)
  ) {
    account.isExhausted = false
    consola.info(`Account "${account.label}" quota refreshed — re-activating`)
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
  const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: {
      ...githubHeaders(state),
      authorization: `token ${account.githubToken}`,
    },
  })

  if (!response.ok) throw new HTTPError("Failed to get Copilot usage", response)

  return (await response.json()) as Awaited<
    ReturnType<typeof getCopilotUsageForAccount>
  >
}

function snapshotFromUsage(
  usage: Awaited<ReturnType<typeof getCopilotUsageForAccount>>,
): QuotaSnapshot {
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
    completionsRemaining: completions?.remaining,
    unlimited,
  }
}
