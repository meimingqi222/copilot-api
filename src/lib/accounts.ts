import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import {
  getRemainingCooldownSeconds,
  reportUpstreamRateLimit,
} from "~/lib/rate-limit"
import { state } from "~/lib/state"

export type AccountProvider = "copilot" | "codebuff"

export interface CodebuffAccountConfig {
  codebuffAuthToken?: string
  codebuffBaseUrl?: string
  codebuffCliVersion?: string
  codebuffAgentId?: string
  codebuffCostMode?: string
  codebuffAllowFallbacks?: boolean
}

export interface Account extends CodebuffAccountConfig {
  id: string
  label: string
  provider?: AccountProvider
  githubToken?: string
  copilotToken?: string
  copilotTokenExpiry?: number
  quotaInfo?: QuotaSnapshot
  availableModels?: Array<AccountModel>
  enabled: boolean // 用户控制是否启用(参与负载均衡)
  priority: number // 优先级，数值越小优先级越高，默认为 0
  isExhausted: boolean
  exhaustedAt?: number
  createdAt: number
}

export interface AccountModel {
  id: string
  name: string
  vendor: string
  pickerEnabled: boolean
  pickerCategory?: string
  supportedEndpoints: Array<string>
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
    // Clear isExhausted on startup since rate limiter cooldown state is in-memory
    // If upstream is still rate limiting, the next request will re-trigger it
    for (const account of state.accounts) {
      if (account.isExhausted) {
        account.isExhausted = false
        consola.info(
          `Cleared exhausted flag for account "${account.label}" on startup`,
        )
      }
    }
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
        provider: "copilot",
        githubToken: legacyToken.trim(),
        enabled: true,
        priority: 0,
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
 * Get an account that supports the given model, sorted by priority (lower is higher priority).
 * Accounts with the same priority are selected in their original order (stable).
 * Falls back to the first available account that supports the model.
 * If no account specifies model support (availableModels is undefined), any enabled/non-exhausted account works.
 */

/**
 * Check if an account's cooldown has expired and clear isExhausted if so.
 * This ensures accounts become available again after the rate limit cooldown period.
 */
function checkAndClearExpiredCooldown(account: Account): boolean {
  if (!account.isExhausted) return false

  const remainingCooldown = getRemainingCooldownSeconds(account.id)
  if (remainingCooldown <= 0) {
    account.isExhausted = false
    consola.info(`Account "${account.label}" cooldown expired — re-activating`)
    return true
  }
  return false
}

function rateLimitedResponse(body: string): Response {
  let minCooldown = 0
  for (const account of state.accounts) {
    if (account.enabled && account.isExhausted) {
      const cooldown = getRemainingCooldownSeconds(account.id)
      if (cooldown > 0 && (minCooldown === 0 || cooldown < minCooldown)) {
        minCooldown = cooldown
      }
    }
  }
  return new Response(body, {
    status: 429,
    headers: minCooldown > 0 ? { "Retry-After": String(minCooldown) } : {},
  })
}

function getAccountProvider(account: Account): AccountProvider {
  return account.provider ?? "copilot"
}

function supportsModelExplicitly(account: Account, modelId: string): boolean {
  return account.availableModels?.some((model) => model.id === modelId) ?? false
}

function supportsModelWithFallback(account: Account, modelId: string): boolean {
  return supportsModelExplicitly(account, modelId) || !account.availableModels
}

function inferProviderForModel(modelId: string): AccountProvider {
  const normalized = modelId.toLowerCase()
  if (normalized.includes("codebuff")) {
    return "codebuff"
  }

  const codebuffModelExists = state.accounts.some(
    (account) =>
      getAccountProvider(account) === "codebuff"
      && supportsModelExplicitly(account, modelId),
  )

  if (codebuffModelExists) {
    return "codebuff"
  }

  return "copilot"
}

export function getAccountForModel(modelId: string): Account {
  // First, clear isExhausted for any accounts whose cooldown has expired
  for (const account of state.accounts) {
    checkAndClearExpiredCooldown(account)
  }

  // Get available accounts and sort by priority (stable sort by array index for same priority)
  const available = state.accounts
    .filter((a) => a.enabled && !a.isExhausted)
    .map((a, originalIndex) => ({ account: a, originalIndex }))
    .sort((left, right) => {
      const leftPriority = left.account.priority
      const rightPriority = right.account.priority
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority
      }
      return left.originalIndex - right.originalIndex
    })
    .map((item) => item.account)

  if (available.length === 0) {
    // Check if there are enabled accounts that are exhausted (rate limited)
    const hasExhaustedAccounts = state.accounts.some(
      (a) => a.enabled && a.isExhausted,
    )
    if (hasExhaustedAccounts) {
      throw new HTTPError(
        "All accounts are temporarily unavailable due to rate limiting",
        rateLimitedResponse("Too Many Requests"),
      )
    }
    throw new HTTPError(
      "No available accounts (all disabled or no accounts configured)",
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  // Prefer accounts that explicitly declare support for this model.
  const expectedProvider = inferProviderForModel(modelId)
  const providerMatched = available.filter(
    (account) => getAccountProvider(account) === expectedProvider,
  )

  const capablePool = providerMatched.length > 0 ? providerMatched : available

  const explicitlyCapable = capablePool.filter((account) =>
    supportsModelExplicitly(account, modelId),
  )
  const capable =
    explicitlyCapable.length > 0 ?
      explicitlyCapable
    : capablePool.filter((account) =>
        supportsModelWithFallback(account, modelId),
      )

  if (capable.length === 0) {
    // Check if any exhausted account supports this model
    const exhaustedEnabled = state.accounts.filter(
      (account) =>
        account.enabled
        && account.isExhausted
        && (providerMatched.length === 0
          || getAccountProvider(account) === expectedProvider),
    )
    const exhaustedExplicit = exhaustedEnabled.filter((account) =>
      supportsModelExplicitly(account, modelId),
    )
    const exhaustedWithModel =
      exhaustedExplicit.length > 0 ?
        exhaustedExplicit
      : exhaustedEnabled.filter((account) =>
          supportsModelWithFallback(account, modelId),
        )
    if (exhaustedWithModel.length > 0) {
      throw new HTTPError(
        `All accounts supporting model "${modelId}" are rate limited`,
        rateLimitedResponse("Too Many Requests"),
      )
    }
    throw new HTTPError(
      `No available account supports model "${modelId}"`,
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  // Return the highest priority capable account
  const selected = capable[0]
  state.activeAccountIndex = state.accounts.indexOf(selected)
  state.githubToken =
    getAccountProvider(selected) === "copilot" ?
      selected.githubToken
    : undefined
  return selected
}

/**
 * Switch to next account that supports the given model, sorted by priority.
 */
export function switchToNextAccountForModel(
  currentAccount: Account,
  modelId: string,
): Account | null {
  // Sort accounts by priority (stable sort)
  const sorted = state.accounts
    .map((account, originalIndex) => ({ account, originalIndex }))
    .sort((left, right) => {
      const leftPriority = left.account.priority
      const rightPriority = right.account.priority
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority
      }
      return left.originalIndex - right.originalIndex
    })
    .map((item) => item.account)

  const expectedProvider = inferProviderForModel(modelId)
  const providerMatched = sorted.filter(
    (account) =>
      account.enabled
      && !account.isExhausted
      && getAccountProvider(account) === expectedProvider,
  )

  const capablePool =
    providerMatched.length > 0 ?
      providerMatched
    : sorted.filter((account) => account.enabled && !account.isExhausted)

  const explicitCapable = capablePool.filter((account) =>
    supportsModelExplicitly(account, modelId),
  )
  const fallbackCapable = capablePool.filter((account) =>
    supportsModelWithFallback(account, modelId),
  )
  const capable = explicitCapable.length > 0 ? explicitCapable : fallbackCapable

  if (capable.length === 0) {
    return null
  }

  // Find current account in sorted list and get the next capable one
  const currentIdx = capable.indexOf(currentAccount)
  for (let i = 1; i <= capable.length; i++) {
    const idx = currentIdx === -1 ? i - 1 : (currentIdx + i) % capable.length
    const account = capable[idx]

    state.activeAccountIndex = state.accounts.indexOf(account)
    state.githubToken = account.githubToken
    consola.info(
      `Switched to account "${account.label}" for model "${modelId}"`,
    )
    return account
  }
  return null
}

export function getActiveAccount(): Account {
  // First, clear isExhausted for any accounts whose cooldown has expired
  for (const account of state.accounts) {
    checkAndClearExpiredCooldown(account)
  }

  // Get available accounts sorted by priority
  const sorted = state.accounts
    .filter((a) => a.enabled && !a.isExhausted)
    .map((account, originalIndex) => ({ account, originalIndex }))
    .sort((left, right) => {
      const leftPriority = left.account.priority
      const rightPriority = right.account.priority
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority
      }
      return left.originalIndex - right.originalIndex
    })
    .map((item) => item.account)

  if (sorted.length === 0) {
    // Check if there are enabled accounts that are exhausted (rate limited)
    const hasExhaustedAccounts = state.accounts.some(
      (a) => a.enabled && a.isExhausted,
    )
    if (hasExhaustedAccounts) {
      throw new HTTPError(
        "All accounts are temporarily unavailable due to rate limiting",
        rateLimitedResponse("Too Many Requests"),
      )
    }
    throw new HTTPError(
      "No available accounts (all disabled or no accounts configured)",
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  const selected = sorted[0]
  state.activeAccountIndex = state.accounts.indexOf(selected)
  // Sync state.githubToken for backward compat
  state.githubToken =
    getAccountProvider(selected) === "copilot" ?
      selected.githubToken
    : undefined
  return selected
}

export function markAccountExhausted(id: string): void {
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return
  if (account.isExhausted) return

  if (getAccountProvider(account) !== "copilot") {
    return
  }

  account.isExhausted = true
  account.exhaustedAt = Date.now()
  const cooldownSeconds = getRemainingCooldownSeconds(id)
  const cooldownInfo =
    cooldownSeconds > 0 ? ` (cooldown: ${cooldownSeconds}s remaining)` : ""
  consola.warn(
    `Account "${account.label}" marked as quota-exhausted${cooldownInfo}`,
  )
  switchToNextAccount()
}

export function switchToNextAccount(): Account | null {
  // Sort accounts by priority (stable sort)
  const sorted = state.accounts
    .map((account, originalIndex) => ({ account, originalIndex }))
    .sort((left, right) => {
      const leftPriority = left.account.priority
      const rightPriority = right.account.priority
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority
      }
      return left.originalIndex - right.originalIndex
    })
    .map((item) => item.account)

  // Find next enabled and non-exhausted account after current
  const currentIdx = sorted.indexOf(state.accounts[state.activeAccountIndex])
  for (let i = 1; i < sorted.length; i++) {
    const idx = (currentIdx + i) % sorted.length
    const account = sorted[idx]
    // 只切换到已启用且未耗尽的账户
    if (account.enabled && !account.isExhausted) {
      state.activeAccountIndex = state.accounts.indexOf(account)
      // Sync state.githubToken for backward compat
      state.githubToken =
        getAccountProvider(account) === "copilot" ?
          account.githubToken
        : undefined
      consola.info(`Switched to account "${account.label}"`)
      return account
    }
  }
  return null
}

const TOKEN_REFRESH_RETRY_DELAY_MS = 60_000

/**
 * Schedule a token refresh retry for an account after a fixed backoff delay.
 * Called when a scheduled refresh fails, to keep the timer chain alive.
 * If the retry also fails, it calls itself again — ensuring continuous retries
 * until the account is deleted or the refresh eventually succeeds (which will
 * re-enter the normal refresh scheduling path inside refreshCopilotToken).
 */
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

  if (!account.githubToken) {
    throw new Error(`GitHub token missing for account "${account.label}"`)
  }

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

  // Use accountId instead of account object reference to avoid stale closures
  const accountId = account.id
  const timerId = setTimeout(() => {
    // Find the current account object from state.accounts to avoid stale references
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
      // refreshCopilotToken only schedules the next timer on success.
      // On failure we must reschedule manually to keep the chain alive.
      scheduleTokenRefreshRetry(accountId)
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
      const existingAccount = existing.find(
        (a) => a.provider === "copilot" && a.githubToken === token,
      )
      if (existingAccount) return existingAccount
      return {
        id: randomUUID(),
        label: index === 0 ? "default" : `account-${index + 1}`,
        provider: "copilot",
        githubToken: token,
        enabled: true,
        priority: 0,
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
  state.githubToken =
    active && getAccountProvider(active) === "copilot" ?
      active.githubToken
    : undefined
}

// Migrate old isActive field to enabled field for backward compatibility
function migrateAccount(account: Record<string, unknown>): Account {
  const acc = account as Partial<Account> & {
    isActive?: boolean
    enabled?: boolean
    priority?: number
    provider?: AccountProvider
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

  // Default priority to 0 if not set
  if (typeof acc.priority !== "number") {
    acc.priority = 0
  }

  // Default provider for legacy account records
  if (acc.provider !== "copilot" && acc.provider !== "codebuff") {
    acc.provider = "copilot"
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
  if (getAccountProvider(account) !== "copilot") {
    return
  }

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
  if (!account.githubToken) {
    throw new Error(`GitHub token missing for account "${account.label}"`)
  }

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

/**
 * Try the next available account for a model when the current account fails with 429.
 * Handles rate limiting, account exhaustion marking, and failover logic.
 *
 * @param currentAccount - The account that just failed
 * @param modelId - The model being requested
 * @param doRequest - Function to execute the request with a given account
 * @returns The response and the account that was used
 */
export async function tryNextAccountForModel(
  currentAccount: Account,
  modelId: string,
  doRequest: (account: Account) => Promise<Response>,
): Promise<{ response: Response; account: Account }> {
  const nextAccount = switchToNextAccountForModel(currentAccount, modelId)

  // No other account available or same account returned
  if (!nextAccount || nextAccount.id === currentAccount.id) {
    return {
      response: rateLimitedResponse("All accounts exhausted"),
      account: currentAccount,
    }
  }

  try {
    const response = await doRequest(nextAccount)

    // If the retry account also returns 429, report rate limit and mark exhausted
    if (response.status === 429) {
      await reportUpstreamRateLimit(nextAccount.id, response)
      markAccountExhausted(nextAccount.id)
    }

    return { response, account: nextAccount }
  } catch (error) {
    consola.warn(`Request failed for account "${nextAccount.label}":`, error)
    return {
      response: rateLimitedResponse("All accounts exhausted"),
      account: nextAccount,
    }
  }
}
