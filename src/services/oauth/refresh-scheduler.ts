import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { isOAuthProviderId } from "~/lib/provider-config"
import {
  getConnectionAuthError,
  getConnectionAuthStatus,
  getConnectionProvider,
  getConnectionProxyUrl,
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
  // 实测（OpenAI/Codex 刷新端点）：会话被作废时回
  // `{"error":{"code":"refresh_token_invalidated","message":"Your session has ended. Please log in again."}}`，
  // ChatGPT 上游失效 token 时回 `code: "token_revoked"`。两者都只认裸
  // RFC 6749 的 invalid_grant 集合会漏判 → 被当成瞬态错误无限退避重试，
  // WebUI 永远不显示"重新认证"。
  "refresh_token_invalidated",
  "token_revoked",
  // auth.openai.com 在 refresh token 已轮换/已作废（例如同一账号在别处重新
  // 登录）时回 `{"error":{"code":"invalid_refresh_token","message":"Could not
  // validate your refresh token. Please try signing in again."}}`。它的字符串
  // 不含 "invalid_grant"，漏列同样会被当成瞬态错误无限重试。
  "invalid_refresh_token",
] as const

/** OAuth 错误体里的 code 字段形状（不同上游嵌套层级不一）。 */
function oauthErrorCodesFromBody(body: string): Array<string> {
  const start = body.indexOf("{")
  if (start < 0) return []
  try {
    const parsed = JSON.parse(body.slice(start)) as Record<string, unknown>
    const nested =
      parsed.error && typeof parsed.error === "object" ?
        (parsed.error as Record<string, unknown>)
      : {}
    const codes: Array<string> = []
    for (const value of [
      parsed.code,
      parsed.error_code,
      parsed.error,
      nested.code,
      nested.type,
    ]) {
      if (typeof value === "string") codes.push(value.toLowerCase())
    }
    return codes
  } catch {
    // 非 JSON（或已被截断）——退回纯文本匹配。
    return []
  }
}

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
function getOAuthConnectionProvider(
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

/** Statuses where the vendor answered and turned the token down. */
const REFUSED_STATUSES = new Set([400, 401])

/** Body codes that keep an otherwise refused-looking answer transient. */
const TRANSIENT_ERROR_PATTERNS = [
  "temporarily_unavailable",
  "server_error",
] as const

/** The HTTP status behind a refresh error: an HTTPError's, or the `(NNN)` a
 *  provider bakes into its message ("Codex token refresh failed (401): …"). */
function oauthErrorStatus(error: unknown): number | undefined {
  if (error instanceof HTTPError) return error.response.status
  const message = error instanceof Error ? error.message : String(error)
  const match = /\((\d{3})\)/.exec(message) ?? /HTTP (\d{3})/i.exec(message)
  return match ? Number(match[1]) : undefined
}

function oauthErrorBody(error: unknown): string {
  if (error instanceof HTTPError) return error.responseBody
  return error instanceof Error ? error.message : String(error)
}

/**
 * Detect whether an OAuth refresh error is terminal (permanent).
 *
 * The primary rule is the HTTP status, not the body's code: a vendor that
 * answered 400 or 401 has turned the token down, and the sign-in is gone
 * whatever the body says. Keying on the status means a code we have never seen
 * — OpenAI's `invalid_refresh_token`, say — can never be misread as a hiccup
 * and retried forever. The body's code is used only to pull a genuinely
 * transient answer back out (`temporarily_unavailable`), and as a safety net
 * for a terminal code that arrives with no 400/401 status.
 */
export function isOAuthTerminalError(error: unknown): boolean {
  const body = oauthErrorBody(error)
  // 能解析出 OAuth code 时只认 code 字段，避免被 message/description 里偶然
  // 出现的同名词误判；解析不出（非 JSON、被截断）才退回全文匹配。
  const codes = oauthErrorCodesFromBody(body)
  const haystack = codes.length > 0 ? codes.join(" ") : body.toLowerCase()
  const names = (patterns: ReadonlyArray<string>): boolean =>
    patterns.some((pattern) => haystack.includes(pattern.toLowerCase()))

  // A refused-looking answer that names a transient condition stays transient.
  if (names(TRANSIENT_ERROR_PATTERNS)) return false

  const status = oauthErrorStatus(error)
  if (status !== undefined && REFUSED_STATUSES.has(status)) return true

  // Safety net: a terminal code on any other status (or with none at all).
  return names(TERMINAL_ERROR_PATTERNS)
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
 * apply*OAuthBundle 在独立副本上解析，再由宿主合并认证更新并统一持久化。
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
      // 终态：refresh token 已作废，重试永远不会成功。必须停掉退避重试并把
      // auth_error 落到磁盘，WebUI 才会出现"重新认证"（availability 也会因此
      // 把该连接移出路由）。请求期（401 → forceRefresh）与调度期共用这一条。
      await markOAuthConnectionAuthError(
        connection,
        error instanceof Error ? error.message : String(error),
      )
    }
    throw error
  }
}

/** 安排 connection 的 OAuth token 刷新。 */
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

export function scheduleOAuthRefreshForAllConnections(): void {
  for (const connection of listProviderConnections()) {
    if (getOAuthConnectionProvider(connection)) {
      scheduleOAuthRefreshForConnection(connection)
    }
  }
}
