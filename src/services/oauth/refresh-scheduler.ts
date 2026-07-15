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
import { logger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  syncAccountToConnection,
} from "~/lib/provider-connections"

import {
  OAUTH_REFRESH_LEAD_MS,
  OAUTH_REFRESH_STRATEGIES,
} from "./refresh-strategies"

const DEFAULT_REFRESH_LEAD_MS = 5 * 60 * 1000
const RETRY_DELAY_MS = 60_000

const oauthRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

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
          return
        }

        try {
          await refreshOAuthAccountToken(account, reason)
        } catch (error: unknown) {
          logger.warn(
            `OAuth refresh failed for "${account.label}", retrying in ${RETRY_DELAY_MS / 1000}s:`,
            error,
          )
          scheduleOAuthRefreshAttempt(accountId, RETRY_DELAY_MS, "retry")
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
