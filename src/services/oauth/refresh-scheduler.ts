import type { Account } from "~/lib/accounts"

import { saveAccounts } from "~/lib/account-store"
import {
  getOAuthAccessToken,
  getOAuthDeviceId,
  getOAuthProxyUrl,
  getOAuthRefreshToken,
  isOAuthAccount,
  setOAuthCredentials,
} from "~/lib/accounts"
import { logger } from "~/lib/logger"
import { state } from "~/lib/state"

import {
  applyAntigravityOAuthBundle,
  refreshAntigravityTokens,
} from "./antigravity"
import { applyClaudeOAuthBundle, refreshClaudeTokens } from "./claude"
import { applyCodexOAuthBundle, refreshCodexTokens } from "./codex"
import {
  applyKimiOAuthBundle,
  createKimiDeviceId,
  refreshKimiTokens,
} from "./kimi"
import {
  applyXaiOAuthBundle,
  getXaiTokenEndpoint,
  refreshXaiTokens,
} from "./xai"

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

function getRefreshLeadMs(account: Account): number {
  switch (account.provider) {
    case "codex": {
      return 5 * 24 * 60 * 60 * 1000
    }
    case "claude": {
      return 4 * 60 * 60 * 1000
    }
    default: {
      return DEFAULT_REFRESH_LEAD_MS
    }
  }
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
        const account = state.accounts.find((item) => item.id === accountId)
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
    switch (account.provider) {
      case "claude": {
        const bundle = await refreshClaudeTokens(refreshToken, fetchOptions)
        applyClaudeOAuthBundle(account, bundle)
        break
      }
      case "kimi": {
        const deviceId = createKimiDeviceId(getOAuthDeviceId(account))
        const bundle = await refreshKimiTokens(
          refreshToken,
          deviceId,
          fetchOptions,
        )
        applyKimiOAuthBundle(account, bundle)
        if (!getOAuthDeviceId(account)) {
          setOAuthCredentials(account, { deviceId })
        }
        break
      }
      case "codex": {
        const bundle = await refreshCodexTokens(refreshToken, fetchOptions)
        applyCodexOAuthBundle(account, bundle)
        break
      }
      case "antigravity": {
        const bundle = await refreshAntigravityTokens(
          refreshToken,
          fetchOptions,
        )
        applyAntigravityOAuthBundle(account, {
          ...bundle,
          redirectUri:
            account.settings?.redirectUri
            ?? "http://localhost:51121/oauth-callback",
        })
        break
      }
      case "xai": {
        const tokenEndpoint = getXaiTokenEndpoint(account)
        if (!tokenEndpoint) {
          throw new Error("xAI OAuth account is missing token endpoint")
        }
        const bundle = await refreshXaiTokens(
          refreshToken,
          tokenEndpoint,
          fetchOptions,
        )
        applyXaiOAuthBundle(account, bundle)
        break
      }
      default: {
        throw new Error("Unhandled OAuth provider")
      }
    }

    logger.debug(
      `OAuth refresh succeeded for "${account.label}" (${account.provider}, ${reason})`,
    )
    scheduleOAuthRefreshForAccount(account)
    await saveAccounts()
  } catch (error: unknown) {
    account.runtimeState = {
      ...account.runtimeState,
      authStatus: "error",
      lastError: error instanceof Error ? error.message : String(error),
    }
    throw error
  }
}

export function scheduleOAuthRefreshForAccount(account: Account): void {
  if (!isOAuthAccount(account) || !account.enabled) {
    cancelOAuthRefreshTimer(account.id)
    return
  }

  const expiry = getTokenExpiryMs(account)
  const lead = getRefreshLeadMs(account)
  const refreshAt =
    expiry ?
      Math.max(expiry - lead, Date.now() + 1_000)
    : Date.now() + DEFAULT_REFRESH_LEAD_MS
  const delayMs = refreshAt - Date.now()

  scheduleOAuthRefreshAttempt(account.id, delayMs, "scheduled")
}

export function scheduleOAuthRefreshForAllAccounts(): void {
  for (const account of state.accounts) {
    if (isOAuthAccount(account)) {
      scheduleOAuthRefreshForAccount(account)
    }
  }
}
