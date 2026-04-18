/* eslint-disable max-lines */
import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type { ProviderId } from "~/lib/provider-config"

import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { isProviderId } from "~/lib/provider-config"
import {
  getRemainingCooldownSeconds,
  reportUpstreamRateLimit,
} from "~/lib/rate-limit"
import { state } from "~/lib/state"

export type AccountProvider = ProviderId

export interface AccountRuntimeState {
  copilotToken?: string
  copilotTokenExpiry?: number
  windsurfJwt?: string
  windsurfJwtFetchedAt?: number
  authStatus?: "ready" | "pending" | "error"
  lastError?: string
}

export interface CopilotAccountCredentials {
  githubToken?: string
}

export interface CopilotAccountSettings {
  accountType?: string
}

export interface CodebuffAccountConfig {
  codebuffAuthToken?: string
  codebuffBaseUrl?: string
  codebuffCliVersion?: string
  codebuffAgentId?: string
  codebuffModel?: string
  codebuffCostMode?: string
  codebuffAllowFallbacks?: boolean
}

export interface WindsurfAccountConfig {
  windsurfApiKey?: string
  windsurfBaseUrl?: string
  windsurfAppVersion?: string
  windsurfLsVersion?: string
  windsurfDefaultModel?: string
  windsurfClientName?: string
}

export interface BaseAccount {
  id: string
  label: string
  provider: AccountProvider
  quotaInfo?: QuotaSnapshot
  availableModels?: Array<AccountModel>
  enabled: boolean // 用户控制是否启用(参与负载均衡)
  priority: number // 优先级，数值越小优先级越高，默认为 0
  isExhausted: boolean
  exhaustedAt?: number
  createdAt: number
  runtimeState?: AccountRuntimeState
}

export interface CopilotAccount extends BaseAccount {
  provider: "copilot"
  credentials?: CopilotAccountCredentials
  settings?: CopilotAccountSettings
  githubToken?: string
  copilotToken?: string
  copilotTokenExpiry?: number
}

export interface CodebuffAccount extends BaseAccount, CodebuffAccountConfig {
  provider: "codebuff"
  credentials?: {
    authToken?: string
  }
  settings?: {
    baseUrl?: string
    cliVersion?: string
    agentId?: string
    model?: string
    costMode?: string
    allowFallbacks?: boolean
  }
}

export interface WindsurfAccount extends BaseAccount, WindsurfAccountConfig {
  provider: "windsurf"
  credentials?: {
    apiKey?: string
  }
  settings?: {
    baseUrl?: string
    appVersion?: string
    lsVersion?: string
    defaultModel?: string
    clientName?: string
  }
}

export type Account = CopilotAccount | CodebuffAccount | WindsurfAccount

export interface AccountModel {
  id: string
  name: string
  vendor: string
  pickerEnabled: boolean
  pickerCategory?: string
  supportedEndpoints: Array<string>
  provider?: AccountProvider
  upstreamId?: string
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

function defaultProvider(provider?: AccountProvider): AccountProvider {
  return provider ?? "copilot"
}

export function getAccountProvider(account: Account): AccountProvider {
  return defaultProvider(account.provider)
}

export function getGitHubToken(account: Account): string | undefined {
  if (account.provider !== "copilot") {
    return undefined
  }
  return account.credentials?.githubToken ?? account.githubToken
}

export function setGitHubToken(
  account: Account,
  githubToken: string | undefined,
): void {
  if (account.provider !== "copilot") {
    return
  }
  account.credentials = {
    ...account.credentials,
    githubToken,
  }
  account.githubToken = githubToken
}

export function getCopilotToken(account: Account): string | undefined {
  if (account.provider !== "copilot") {
    return undefined
  }
  return account.runtimeState?.copilotToken ?? account.copilotToken
}

export function setCopilotToken(
  account: Account,
  copilotToken: string | undefined,
): void {
  if (account.provider !== "copilot") {
    return
  }
  account.runtimeState = {
    ...account.runtimeState,
    copilotToken,
  }
  account.copilotToken = copilotToken
}

export function getCopilotTokenExpiry(account: Account): number | undefined {
  if (account.provider !== "copilot") {
    return undefined
  }
  return account.runtimeState?.copilotTokenExpiry ?? account.copilotTokenExpiry
}

export function setCopilotTokenExpiry(
  account: Account,
  expiry: number | undefined,
): void {
  if (account.provider !== "copilot") {
    return
  }
  account.runtimeState = {
    ...account.runtimeState,
    copilotTokenExpiry: expiry,
  }
  account.copilotTokenExpiry = expiry
}

export function getCodebuffAuthToken(account: Account): string | undefined {
  if (account.provider !== "codebuff") {
    return undefined
  }
  return account.credentials?.authToken ?? account.codebuffAuthToken
}

export function setCodebuffAuthToken(
  account: Account,
  authToken: string | undefined,
): void {
  if (account.provider !== "codebuff") {
    return
  }
  account.credentials = {
    ...account.credentials,
    authToken,
  }
  account.codebuffAuthToken = authToken
}

export function getWindsurfApiKey(account: Account): string | undefined {
  if (account.provider !== "windsurf") {
    return undefined
  }
  return account.credentials?.apiKey ?? account.windsurfApiKey
}

export function setWindsurfApiKey(
  account: Account,
  apiKey: string | undefined,
): void {
  if (account.provider !== "windsurf") {
    return
  }
  account.credentials = {
    ...account.credentials,
    apiKey,
  }
  account.windsurfApiKey = apiKey
}

export function getWindsurfJwt(account: Account): string | undefined {
  if (account.provider !== "windsurf") {
    return undefined
  }
  return account.runtimeState?.windsurfJwt
}

export function setWindsurfJwt(
  account: Account,
  jwt: string | undefined,
): void {
  if (account.provider !== "windsurf") {
    return
  }
  account.runtimeState = {
    ...account.runtimeState,
    windsurfJwt: jwt,
    windsurfJwtFetchedAt: jwt ? Date.now() : undefined,
  }
}

// eslint-disable-next-line complexity
export function getCodebuffSettings(account: Account) {
  if (account.provider !== "codebuff") {
    return undefined
  }
  const defaults = state.providerDefaults.codebuff
  return {
    authToken: getCodebuffAuthToken(account) ?? defaults.authToken,
    baseUrl:
      account.settings?.baseUrl ?? account.codebuffBaseUrl ?? defaults.baseUrl,
    cliVersion:
      account.settings?.cliVersion
      ?? account.codebuffCliVersion
      ?? defaults.cliVersion,
    agentId:
      account.settings?.agentId ?? account.codebuffAgentId ?? defaults.agentId,
    model: account.settings?.model ?? account.codebuffModel ?? defaults.model,
    costMode:
      account.settings?.costMode
      ?? account.codebuffCostMode
      ?? defaults.costMode,
    allowFallbacks:
      account.settings?.allowFallbacks
      ?? account.codebuffAllowFallbacks
      ?? defaults.allowFallbacks,
  }
}

// eslint-disable-next-line complexity
export function getWindsurfSettings(account: Account) {
  if (account.provider !== "windsurf") {
    return undefined
  }
  const defaults = state.providerDefaults.windsurf
  return {
    apiKey: getWindsurfApiKey(account) ?? defaults.apiKey,
    baseUrl:
      account.settings?.baseUrl ?? account.windsurfBaseUrl ?? defaults.baseUrl,
    appVersion:
      account.settings?.appVersion
      ?? account.windsurfAppVersion
      ?? defaults.appVersion,
    lsVersion:
      account.settings?.lsVersion
      ?? account.windsurfLsVersion
      ?? defaults.lsVersion,
    defaultModel:
      account.settings?.defaultModel
      ?? account.windsurfDefaultModel
      ?? defaults.defaultModel,
    clientName:
      account.settings?.clientName
      ?? account.windsurfClientName
      ?? defaults.clientName,
  }
}

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
        credentials: {
          githubToken: legacyToken.trim(),
        },
        settings: {},
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
  const sanitized = state.accounts.map((account) => serializeAccount(account))
  await fs.writeFile(PATHS.ACCOUNTS_PATH, JSON.stringify(sanitized, null, 2))
}

function serializeAccount(account: Account): Record<string, unknown> {
  const base = {
    id: account.id,
    label: account.label,
    provider: account.provider,
    enabled: account.enabled,
    priority: account.priority,
    isExhausted: account.isExhausted,
    exhaustedAt: account.exhaustedAt,
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

export function canonicalModelId(modelId: string): string {
  const parsed = parseModelReference(modelId)
  return parsed.provider ?
      `${parsed.provider}/${parsed.nativeModelId}`
    : parsed.nativeModelId
}

export function canonicalNativeModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase()
  if (normalized === "z-ai/glm5" || normalized === "glm5") {
    return "z-ai/glm-5.1"
  }
  return normalized
}

export function parseModelReference(modelId: string): {
  provider?: AccountProvider
  nativeModelId: string
} {
  const trimmed = modelId.trim()
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex > 0) {
    const maybeProvider = trimmed.slice(0, slashIndex).toLowerCase()
    if (isProviderId(maybeProvider)) {
      return {
        provider: maybeProvider,
        nativeModelId: canonicalNativeModelId(trimmed.slice(slashIndex + 1)),
      }
    }
  }
  return {
    nativeModelId: canonicalNativeModelId(trimmed),
  }
}

function supportsModelExplicitly(account: Account, modelId: string): boolean {
  const target = parseModelReference(modelId).nativeModelId
  return (
    account.availableModels?.some(
      (model) => canonicalNativeModelId(model.id) === target,
    ) ?? false
  )
}

function supportsModelWithFallback(account: Account, modelId: string): boolean {
  return supportsModelExplicitly(account, modelId) || !account.availableModels
}

export function getAccountForModel(modelId: string): Account {
  const reference = parseModelReference(modelId)
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

  const providerMatched =
    reference.provider ?
      available.filter(
        (account) => getAccountProvider(account) === reference.provider,
      )
    : available

  const capablePool = reference.provider ? providerMatched : available

  const explicitlyCapable = capablePool.filter((account) =>
    supportsModelExplicitly(account, reference.nativeModelId),
  )
  const capable =
    explicitlyCapable.length > 0 ?
      explicitlyCapable
    : capablePool.filter((account) =>
        supportsModelWithFallback(account, reference.nativeModelId),
      )

  if (capable.length === 0) {
    // Check if any exhausted account supports this model
    const exhaustedEnabled = state.accounts.filter(
      (account) =>
        account.enabled
        && account.isExhausted
        && (!reference.provider
          || getAccountProvider(account) === reference.provider),
    )
    const exhaustedExplicit = exhaustedEnabled.filter((account) =>
      supportsModelExplicitly(account, reference.nativeModelId),
    )
    const exhaustedWithModel =
      exhaustedExplicit.length > 0 ?
        exhaustedExplicit
      : exhaustedEnabled.filter((account) =>
          supportsModelWithFallback(account, reference.nativeModelId),
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
      getGitHubToken(selected)
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
  const reference = parseModelReference(modelId)
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

  const providerMatched =
    reference.provider ?
      sorted.filter(
        (account) =>
          account.enabled
          && !account.isExhausted
          && getAccountProvider(account) === reference.provider,
      )
    : []

  const capablePool =
    reference.provider ? providerMatched : (
      sorted.filter((account) => account.enabled && !account.isExhausted)
    )

  const explicitCapable = capablePool.filter((account) =>
    supportsModelExplicitly(account, reference.nativeModelId),
  )
  const fallbackCapable = capablePool.filter((account) =>
    supportsModelWithFallback(account, reference.nativeModelId),
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
    state.githubToken =
      getAccountProvider(account) === "copilot" ?
        getGitHubToken(account)
      : undefined
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
      getGitHubToken(selected)
    : undefined
  return selected
}

export function markAccountExhausted(id: string): void {
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return
  if (account.isExhausted) return

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
          getGitHubToken(account)
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

  if (!response.ok)
    throw new HTTPError("Failed to get Copilot token for account", response)

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
        (a) => a.provider === "copilot" && getGitHubToken(a) === token,
      )
      if (existingAccount) return existingAccount
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
      getGitHubToken(active)
    : undefined
}

// Migrate old isActive field to enabled field for backward compatibility
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
  if (!isProviderId(String(acc.provider))) {
    acc.provider = "copilot"
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
  } as WindsurfAccount
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
