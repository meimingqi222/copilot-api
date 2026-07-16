import type { Account } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { saveAccounts } from "~/lib/account-store"
import {
  getOAuthAccessToken,
  getOAuthProxyUrl,
  getOAuthRefreshToken,
  isOAuthAccount,
  listAccounts,
} from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  markCredentialAuthError,
  resetCredentialStatus,
  syncAccountToConnection,
} from "~/lib/provider-connections"

import {
  OAUTH_REFRESH_LEAD_MS,
  OAUTH_REFRESH_STRATEGIES,
} from "./refresh-strategies"

const DEFAULT_REFRESH_LEAD_MS = 5 * 60 * 1000
const INITIAL_RETRY_DELAY_MS = 60_000
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000
const MAX_REFRESH_RETRIES = 3

const oauthRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const oauthRetryCounts = new Map<string, number>()

const TERMINAL_ERROR_PATTERNS = [
  "invalid_grant",
  "unauthorized_client",
  "invalid_client",
] as const

export function cancelOAuthRefreshTimer(accountId: string): void {
  const timer = oauthRefreshTimers.get(accountId)
  if (timer) {
    clearTimeout(timer)
    oauthRefreshTimers.delete(accountId)
  }
}

export function cancelAllOAuthRefreshTimers(): void {
  for (const accountId of oauthRefreshTimers.keys()) {
    cancelOAuthRefreshTimer(accountId)
  }
}

function getRefreshLeadMs(provider: OAuthProviderId): number {
  return OAUTH_REFRESH_LEAD_MS[provider] ?? DEFAULT_REFRESH_LEAD_MS
}

function getTokenExpiryMs(account: Account): number | undefined {
  if (!isOAuthAccount(account)) {
    return undefined
  }
  return account.credentials?.expiresAt
}

/**
 * Detect whether an OAuth refresh error is terminal (permanent).
 * Terminal errors (invalid_grant / unauthorized_client / invalid_client)
 * mean the refresh token has been revoked or expired — retrying will
 * never succeed and the account must be re-authenticated.
 */
function isOAuthTerminalError(error: unknown): boolean {
  if (error instanceof HTTPError) {
    if (error.response.status === 400 || error.response.status === 401) {
      const body = error.responseBody.toLowerCase()
      return TERMINAL_ERROR_PATTERNS.some((pattern) =>
        body.includes(pattern.toLowerCase()),
      )
    }
    return false
  }
  const message =
    error instanceof Error ?
      error.message.toLowerCase()
    : String(error).toLowerCase()
  return TERMINAL_ERROR_PATTERNS.some((pattern) =>
    message.includes(pattern.toLowerCase()),
  )
}

/**
 * Mark an OAuth account’s credential as permanently failed (auth_error).
 * Stops all retry timers and persists the auth_error status to disk
 * so it survives restarts.
 */
async function markOAuthAccountAuthError(
  account: Account,
  reason: string,
): Promise<void> {
  cancelOAuthRefreshTimer(account.id)
  oauthRetryCounts.delete(account.id)

  account.runtimeState = {
    ...account.runtimeState,
    authStatus: "error",
    lastError: reason,
  }

  const conn = getMutableProviderConnection(account.id)
  if (conn && conn.credentials.length > 0) {
    markCredentialAuthError(conn.credentials[0], reason)
    syncAccountToConnection(conn, account)
  }

  await saveAccounts()

  logger.error(
    `OAuth refresh permanently failed for "${account.label}" (${account.provider}): ${reason}. `
      + `Account must be re-authenticated manually.`,
  )
}

function scheduleOAuthRefreshAttempt(
  accountId: string,
  delayMs: number,
  reason: string,
): void {
  cancelOAuthRefreshTimer(accountId)

  const timer = setTimeout(
    () => {
      void (async () => {
        const account = listAccounts().find((item) => item.id === accountId)
        if (!account || !account.enabled || !isOAuthAccount(account)) {
          cancelOAuthRefreshTimer(accountId)
          oauthRetryCounts.delete(accountId)
          return
        }

        try {
          await refreshOAuthAccountToken(account, reason)
          // Success — reset retry count
          oauthRetryCounts.delete(accountId)
        } catch (error: unknown) {
          // Check if this is a terminal (permanent) error
          if (isOAuthTerminalError(error)) {
            await markOAuthAccountAuthError(
              account,
              `Terminal OAuth error: ${error instanceof Error ? error.message : String(error)}`,
            )
            return
          }

          // Track retry count with exponential backoff
          const retryCount = (oauthRetryCounts.get(accountId) ?? 0) + 1
          oauthRetryCounts.set(accountId, retryCount)

          if (retryCount >= MAX_REFRESH_RETRIES) {
            await markOAuthAccountAuthError(
              account,
              `OAuth refresh failed after ${MAX_REFRESH_RETRIES} retries: ${error instanceof Error ? error.message : String(error)}`,
            )
            return
          }

          const backoffMs = Math.min(
            INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount - 1),
            MAX_RETRY_DELAY_MS,
          )
          logger.warn(
            `OAuth refresh failed for "${account.label}" (attempt ${retryCount}/${MAX_REFRESH_RETRIES}), `
              + `retrying in ${backoffMs / 1000}s:`,
            error instanceof Error ? error.message : String(error),
          )
          scheduleOAuthRefreshAttempt(accountId, backoffMs, "retry")
        }
      })()
    },
    Math.max(delayMs, 1_000),
  )

  oauthRefreshTimers.set(accountId, timer)
}

export async function refreshOAuthAccountToken(
  account: Account,
  reason = "scheduled",
): Promise<void> {
  if (!isOAuthAccount(account) || !account.enabled) {
    return
  }

  const refreshToken = getOAuthRefreshToken(account)
  const accessToken = getOAuthAccessToken(account)

  if (!refreshToken && !accessToken) {
    account.runtimeState = {
      ...account.runtimeState,
      authStatus: "error",
      lastError: "Missing OAuth credentials",
    }
    return
  }

  if (!refreshToken) {
    account.runtimeState = {
      ...account.runtimeState,
      authStatus: "ready",
      lastRefreshAt: Date.now(),
      lastError: undefined,
    }
    return
  }

  const fetchOptions = { proxyUrl: getOAuthProxyUrl(account) }

  try {
    await OAUTH_REFRESH_STRATEGIES[account.provider](
      account,
      refreshToken,
      fetchOptions,
    )

    // Reset auth status on success — a previous failed attempt may have
    // set authStatus to "error". Without this reset,
    // scheduleOAuthRefreshForAccount would skip scheduling (and
    // getAccountAvailability would keep reporting the account unavailable).
    account.runtimeState = {
      ...account.runtimeState,
      authStatus: "ready",
      lastError: undefined,
      lastRefreshAt: Date.now(),
    }

    logger.debug(
      `OAuth refresh succeeded for "${account.label}" (${account.provider}, ${reason})`,
    )
    scheduleOAuthRefreshForAccount(account)
    const conn = getMutableProviderConnection(account.id)
    if (conn) syncAccountToConnection(conn, account)
    await saveAccounts()
  } catch (error: unknown) {
    account.runtimeState = {
      ...account.runtimeState,
      authStatus: "error",
      lastError: error instanceof Error ? error.message : String(error),
    }
    const conn = getMutableProviderConnection(account.id)
    if (conn) syncAccountToConnection(conn, account)
    throw error
  }
}

export function scheduleOAuthRefreshForAccount(account: Account): void {
  if (!isOAuthAccount(account) || !account.enabled) {
    cancelOAuthRefreshTimer(account.id)
    return
  }

  // Skip if the account is already in permanent auth_error state
  if (account.runtimeState?.authStatus === "error") {
    return
  }

  // Reset retry count on fresh schedule
  oauthRetryCounts.delete(account.id)

  const expiry = getTokenExpiryMs(account)
  const lead = getRefreshLeadMs(account.provider)
  const refreshAt =
    expiry ?
      Math.max(expiry - lead, Date.now() + 1_000)
    : Date.now() + DEFAULT_REFRESH_LEAD_MS
  const delayMs = refreshAt - Date.now()

  scheduleOAuthRefreshAttempt(account.id, delayMs, "scheduled")
}

export function scheduleOAuthRefreshForAllAccounts(): void {
  for (const account of listAccounts()) {
    if (isOAuthAccount(account)) {
      scheduleOAuthRefreshForAccount(account)
    }
  }
}

/**
 * Clear auth_error state and reschedule refresh for an account.
 * Called when user manually re-authenticates or resets account credentials.
 */
export function clearOAuthAuthError(accountId: string): void {
  oauthRetryCounts.delete(accountId)
  const account = listAccounts().find((a) => a.id === accountId)
  if (!account || !isOAuthAccount(account)) {
    return
  }

  // Reset runtime auth state so scheduleOAuthRefreshForAccount will not
  // bail out immediately.
  account.runtimeState = {
    ...account.runtimeState,
    authStatus: "ready",
    lastError: undefined,
  }

  // Also reset the persisted credential status if it was locked to auth_error.
  const conn = getMutableProviderConnection(account.id)
  if (conn && conn.credentials.length > 0) {
    const cred = conn.credentials[0]
    if (cred.status === "auth_error") {
      resetCredentialStatus(cred)
    }
    syncAccountToConnection(conn, account)
  }

  saveAccounts().catch((err: unknown) => {
    logger.error(
      `Failed to persist cleared OAuth auth_error state for "${account.label}":`,
      err instanceof Error ? err.message : String(err),
    )
  })

  scheduleOAuthRefreshForAccount(account)
}
