import type { Account } from "~/lib/legacy-accounts"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { isOAuthAccount } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { isOAuthProviderId } from "~/lib/provider-config"
import {
  getConnectionAuthError,
  getConnectionAuthStatus,
  getConnectionProvider,
  getConnectionProxyUrl,
  getConnectionSettings,
  getCredentialContextNumber,
  getCredentialContextString,
  getMutableProviderConnection,
  listProviderConnections,
  persistProviderConnections,
  setConnectionAuthStatus,
} from "~/lib/provider-connections"

import { extractJwtExpiryMs } from "./jwt"
import {
  OAUTH_REFRESH_LEAD_MS,
  OAUTH_REFRESH_STRATEGIES,
} from "./refresh-strategies"

const DEFAULT_REFRESH_LEAD_MS = 5 * 60 * 1000
const INITIAL_RETRY_DELAY_MS = 60_000
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000

const oauthRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const oauthRetryCounts = new Map<string, number>()
const oauthRefreshInflight = new Map<string, Promise<void>>()

const TERMINAL_ERROR_PATTERNS = [
  "invalid_grant",
  "unauthorized_client",
  "invalid_client",
  "refresh_token_reused",
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

/** 读取 connection 的 OAuth provider(非 OAuth connection 返回 undefined)。 */
export function getOAuthConnectionProvider(
  connection: ProviderConnection,
): OAuthProviderId | undefined {
  const provider = getConnectionProvider(connection)
  return provider !== undefined && isOAuthProviderId(provider) ?
      provider
    : undefined
}

function getRefreshLeadMs(provider: OAuthProviderId): number {
  return OAUTH_REFRESH_LEAD_MS[provider] ?? DEFAULT_REFRESH_LEAD_MS
}

function getConnectionTokenExpiryMs(
  connection: ProviderConnection,
): number | undefined {
  return (
    getCredentialContextNumber(connection, "expiresAt")
    ?? extractJwtExpiryMs(connection.credentials[0]?.value)
  )
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
 * Mark an OAuth connection's credential as permanently failed (auth_error).
 * Stops all retry timers and persists the auth_error status to disk
 * so it survives restarts.
 */
async function markOAuthConnectionAuthError(
  connection: ProviderConnection,
  reason: string,
): Promise<void> {
  cancelOAuthRefreshTimer(connection.id)
  oauthRetryCounts.delete(connection.id)

  setConnectionAuthStatus(connection, "error", reason)
  await persistProviderConnections()

  logger.error(
    `OAuth refresh permanently failed for "${connection.name}" (${getConnectionProvider(connection)}): ${reason}. `
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
        const connection = getMutableProviderConnection(accountId)
        // Disabled accounts still get token refresh — disabling only removes
        // them from request routing, not from token lifecycle.
        if (!connection || !getOAuthConnectionProvider(connection)) {
          cancelOAuthRefreshTimer(accountId)
          oauthRetryCounts.delete(accountId)
          return
        }

        try {
          await refreshOAuthConnectionToken(connection, reason)
          // Success — reset retry count
          oauthRetryCounts.delete(accountId)
        } catch (error: unknown) {
          // Check if this is a terminal (permanent) error
          if (isOAuthTerminalError(error)) {
            await markOAuthConnectionAuthError(
              connection,
              `Terminal OAuth error: ${error instanceof Error ? error.message : String(error)}`,
            )
            return
          }

          // Transient network/server failures must not permanently revoke an
          // otherwise recoverable credential. Keep retrying with capped
          // exponential backoff; only explicit OAuth terminal errors above
          // require a new login.
          const retryCount = (oauthRetryCounts.get(accountId) ?? 0) + 1
          oauthRetryCounts.set(accountId, retryCount)
          const backoffMs = Math.min(
            INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount - 1),
            MAX_RETRY_DELAY_MS,
          )
          logger.warn(
            `OAuth refresh failed for "${connection.name}" (attempt ${retryCount}), `
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

/**
 * connection 原生的 OAuth token 刷新核心。
 * 刷新材料从 credential.context 读取,刷新结果经各 provider 的
 * apply*OAuthBundle 直接写回 connection(credential.value / context /
 * credentialExtras / metadata.authStatus),最后统一持久化。
 */
export async function refreshOAuthConnectionToken(
  connection: ProviderConnection,
  reason = "scheduled",
): Promise<void> {
  const existing = oauthRefreshInflight.get(connection.id)
  if (existing) {
    await existing
    return
  }

  // Every refresh entry point (scheduler, request-time 401 recovery, admin,
  // quota) shares this lock. Rotating refresh tokens must never be consumed by
  // two concurrent requests for the same connection.
  const liveConnection =
    getMutableProviderConnection(connection.id) ?? connection
  const refresh = refreshOAuthConnectionTokenOnce(
    liveConnection,
    reason,
  ).finally(() => oauthRefreshInflight.delete(connection.id))
  oauthRefreshInflight.set(connection.id, refresh)
  await refresh
}

async function refreshOAuthConnectionTokenOnce(
  connection: ProviderConnection,
  reason: string,
): Promise<void> {
  // Note: intentionally not gated on `connection.enabled` — a disabled account
  // must still be able to refresh its OAuth token so quota/token stays valid.
  const provider = getOAuthConnectionProvider(connection)
  if (!provider) return

  const refreshToken = getCredentialContextString(connection, "refreshToken")
  const accessToken = connection.credentials[0]?.value || undefined

  if (!refreshToken && !accessToken) {
    setConnectionAuthStatus(connection, "error", "Missing OAuth credentials")
    await persistProviderConnections()
    return
  }

  if (!refreshToken) {
    setConnectionAuthStatus(connection, "ready")
    return
  }

  const fetchOptions = { proxyUrl: getConnectionProxyUrl(connection) }

  try {
    await OAUTH_REFRESH_STRATEGIES[provider](
      connection,
      refreshToken,
      fetchOptions,
    )

    logger.debug(
      `OAuth refresh succeeded for "${connection.name}" (${provider}, ${reason})`,
    )
    scheduleOAuthRefreshForConnection(connection)
    await persistProviderConnections()
  } catch (error: unknown) {
    // Do not turn a temporary DNS/TLS/upstream outage into auth_error. The old
    // access token may still be valid, and the scheduler will retry. Only an
    // explicit OAuth terminal response proves that re-authentication is needed.
    if (isOAuthTerminalError(error)) {
      setConnectionAuthStatus(
        connection,
        "error",
        error instanceof Error ? error.message : String(error),
      )
      await persistProviderConnections()
    }
    throw error
  }
}

/**
 * Account 桥接层:从 connection 反查刷新,并把结果同步回调用方持有的
 * Account 快照(等价旧版对 account 的 in-place mutation)。
 */
export async function refreshOAuthAccountToken(
  account: Account,
  reason = "scheduled",
): Promise<void> {
  // Note: intentionally not gated on `account.enabled` — a disabled account
  // must still be able to refresh its OAuth token so quota/token stays valid.
  if (!isOAuthAccount(account)) {
    return
  }

  const connection = getMutableProviderConnection(account.id)
  if (!connection) {
    return
  }

  let succeeded = false
  try {
    await refreshOAuthConnectionToken(connection, reason)
    succeeded = true
  } finally {
    // 无论成功或失败,都把 connection 上的最新状态同步回 Account 快照
    // (refreshOAuthConnectionToken 内部已通过 setConnectionAuthStatus 写入
    // ready/error,失败时也会 rethrow,所以用 finally 保证同步)。
    syncConnectionToAccountSnapshot(connection, account, succeeded)
  }
}

/**
 * 把 connection 的最新状态同步回 Account 快照(桥接层专用,Phase 4 删)。
 * 不再通过 connectionToAccount 派生完整快照,而是直接从 connection 字段
 * 读取刷新后会变化的凭据字段(accessToken/refreshToken/expiresAt)、
 * settings(metadata.settings)以及 authStatus/lastError。
 */
function syncConnectionToAccountSnapshot(
  connection: ProviderConnection,
  account: Account,
  succeeded: boolean,
): void {
  // credentials:刷新后只有 accessToken/refreshToken/expiresAt 会变化,直接从 credential 读取
  if (isOAuthAccount(account)) {
    const cred = connection.credentials[0]
    if (cred) {
      account.credentials = {
        ...account.credentials,
        accessToken: cred.value || undefined,
        refreshToken:
          typeof cred.context?.refreshToken === "string" ?
            cred.context.refreshToken
          : account.credentials?.refreshToken,
        expiresAt:
          typeof cred.context?.expiresAt === "number" ?
            cred.context.expiresAt
          : account.credentials?.expiresAt,
      }
    }
  }

  // settings:从 connection.metadata.settings 同步
  const settings = getConnectionSettings(connection)
  if (settings) {
    account.settings = { ...settings }
  }

  // authStatus / lastError 手动写入 runtimeState
  // (connectionToAccount 在 authStatus === "ready" 时不写 runtimeState.authStatus,
  //  旧版 API 契约要求刷新后显式可见,这里补回)
  const authStatus = getConnectionAuthStatus(connection)
  if (authStatus) {
    account.runtimeState = {
      ...account.runtimeState,
      authStatus: authStatus as "ready" | "pending" | "error",
    }
  }
  const authError = getConnectionAuthError(connection)
  if (authError) {
    account.runtimeState = {
      ...account.runtimeState,
      lastError: authError,
    }
  } else if (account.runtimeState) {
    delete account.runtimeState.lastError
  }
  // 旧版 Account 契约:成功刷新后写 lastRefreshAt(新版 connection 不存此字段,
  // 桥接层补回,Phase 4 删)。
  if (succeeded) {
    account.runtimeState = {
      ...account.runtimeState,
      lastRefreshAt: Date.now(),
    }
  }
}

export function scheduleOAuthRefreshForConnection(
  connection: ProviderConnection,
): void {
  // Keep refreshing disabled accounts' tokens in the background (matches the
  // reference CPA behavior): `enabled` gates request routing, not token
  // lifecycle.
  const provider = getOAuthConnectionProvider(connection)
  if (!provider) {
    cancelOAuthRefreshTimer(connection.id)
    return
  }

  // Preserve permanent OAuth failures across restarts, but allow accounts
  // marked by older versions after a transient outage to recover automatically.
  const authError = getConnectionAuthError(connection)
  if (
    getConnectionAuthStatus(connection) === "error"
    && authError
    && isOAuthTerminalError(new Error(authError))
  ) {
    return
  }

  // Reset retry count on fresh schedule
  oauthRetryCounts.delete(connection.id)

  const expiry = getConnectionTokenExpiryMs(connection)
  const lead = getRefreshLeadMs(provider)
  const refreshAt =
    expiry ?
      Math.max(expiry - lead, Date.now() + 1_000)
    : Date.now() + DEFAULT_REFRESH_LEAD_MS
  const delayMs = refreshAt - Date.now()

  scheduleOAuthRefreshAttempt(connection.id, delayMs, "scheduled")
}

/** Account 桥接层:等价 scheduleOAuthRefreshForConnection(account.id)。 */
export function scheduleOAuthRefreshForAccount(account: Account): void {
  if (!isOAuthAccount(account)) {
    cancelOAuthRefreshTimer(account.id)
    return
  }
  const connection = getMutableProviderConnection(account.id)
  if (!connection) {
    cancelOAuthRefreshTimer(account.id)
    return
  }
  scheduleOAuthRefreshForConnection(connection)
}

export function scheduleOAuthRefreshForAllConnections(): void {
  for (const connection of listProviderConnections()) {
    if (getOAuthConnectionProvider(connection)) {
      scheduleOAuthRefreshForConnection(connection)
    }
  }
}
