import type { Account } from "~/lib/accounts"

import {
  getOAuthAccessToken,
  getOAuthRefreshToken,
  isOAuthAccount,
} from "~/lib/accounts"

import { refreshOAuthAccountToken } from "./refresh-scheduler"

const EXPIRY_SKEW_MS = 60_000
const inflightRefresh = new Map<string, Promise<void>>()

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
): Promise<string | undefined> {
  if (!isOAuthAccount(account) || !account.enabled) {
    return getOAuthAccessToken(account)
  }

  if (!tokenNeedsRefresh(account)) {
    return getOAuthAccessToken(account)
  }

  const inflight = inflightRefresh.get(account.id)
  if (inflight) {
    await inflight
    return getOAuthAccessToken(account)
  }

  const refreshPromise = refreshOAuthAccountToken(account, "pre-request")
    .catch((error: unknown) => {
      throw error
    })
    .finally(() => {
      inflightRefresh.delete(account.id)
    })

  inflightRefresh.set(account.id, refreshPromise)
  await refreshPromise
  return getOAuthAccessToken(account)
}
