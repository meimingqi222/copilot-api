import type { Account } from "~/lib/accounts"

import {
  getAccount,
  getOAuthAccessToken,
  getOAuthRefreshToken,
  isOAuthAccount,
} from "~/lib/accounts"

import { refreshOAuthAccountToken } from "./refresh-scheduler"

const EXPIRY_SKEW_MS = 60_000
const inflightRefresh = new Map<string, Promise<void>>()

interface EnsureOAuthAccessTokenOptions {
  forceRefresh?: boolean
  failedAccessToken?: string
}

function getCurrentAccount(account: Account): Account {
  return getAccount(account.id) ?? account
}

function getCurrentAccessToken(account: Account): string | undefined {
  const currentAccount = getCurrentAccount(account)
  if (
    currentAccount !== account
    && isOAuthAccount(account)
    && isOAuthAccount(currentAccount)
  ) {
    account.credentials = { ...currentAccount.credentials }
  }
  return getOAuthAccessToken(currentAccount)
}

function tokenNeedsRefresh(account: Account): boolean {
  if (!isOAuthAccount(account)) {
    return false
  }
  const refreshToken = getOAuthRefreshToken(account)
  if (!refreshToken) {
    return false
  }
  const accessToken = getOAuthAccessToken(account)
  const expiresAt = account.credentials?.expiresAt
  if (!accessToken) {
    return true
  }
  if (expiresAt === undefined) {
    return false
  }
  return expiresAt <= Date.now() + EXPIRY_SKEW_MS
}

export async function ensureOAuthAccessToken(
  account: Account,
  options: EnsureOAuthAccessTokenOptions = {},
): Promise<string | undefined> {
  const currentAccount = getCurrentAccount(account)
  // Token refresh is decoupled from `enabled`: a disabled account is only
  // excluded from request routing, not from token lifecycle. Otherwise a
  // disabled account's access token expires and can never be refreshed,
  // breaking on-demand actions like quota refresh (401 forever).
  if (!isOAuthAccount(currentAccount)) {
    return getOAuthAccessToken(currentAccount)
  }

  const currentToken = getOAuthAccessToken(currentAccount)
  if (
    options.forceRefresh
    && options.failedAccessToken
    && currentToken
    && currentToken !== options.failedAccessToken
  ) {
    return currentToken
  }

  if (!options.forceRefresh && !tokenNeedsRefresh(currentAccount)) {
    return currentToken
  }

  const inflight = inflightRefresh.get(currentAccount.id)
  if (inflight) {
    await inflight
    return getCurrentAccessToken(account)
  }

  const accountId = currentAccount.id
  const refreshPromise = refreshOAuthAccountToken(
    currentAccount,
    options.forceRefresh ? "unauthorized" : "pre-request",
  )
    .catch((error: unknown) => {
      throw error
    })
    .finally(() => {
      inflightRefresh.delete(accountId)
    })

  inflightRefresh.set(accountId, refreshPromise)
  await refreshPromise
  return getCurrentAccessToken(account)
}
