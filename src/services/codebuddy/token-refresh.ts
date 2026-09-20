/**
 * CodeBuddy Token 刷新。
 *
 * CodeBuddy 使用自定义的 refresh 端点（非标准 OAuth refresh_token grant）：
 *   POST https://copilot.tencent.com/v2/plugin/auth/token/refresh
 *   Headers: Authorization: Bearer <oldAccessToken>, X-Refresh-Token: <refreshToken>, ...
 *
 * 成功后返回新的 accessToken + refreshToken，旧 refreshToken 会被轮换失效。
 */

import { randomUUID } from "node:crypto"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections/types"

import { logger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  listProviderConnections,
  persistProviderConnections,
} from "~/lib/provider-connections/state"

const CODEBUDDY_DEFAULT_BASE_URL = "https://copilot.tencent.com/v2"
const CODEBUDDY_DEFAULT_DOMAIN = "www.codebuddy.cn"
const CODEBUDDY_USER_AGENT = "CLI/2.148.0 CodeBuddy/2.148.0"
const CODEBUDDY_PRODUCT = "SaaS"
const REFRESH_LEAD_MS = 5 * 60 * 1000
const REFRESH_RETRY_MS = 60_000
const MAX_TIMER_DELAY_MS = 2_147_000_000

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const persistenceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const inflightRefreshes = new Map<string, Promise<boolean>>()

function schedulePersistenceRetry(connectionId: string): void {
  if (persistenceRetryTimers.has(connectionId)) return
  const timer = setTimeout(() => {
    persistenceRetryTimers.delete(connectionId)
    if (!getMutableProviderConnection(connectionId)) return
    void persistProviderConnections().catch((error: unknown) => {
      logger.error(
        `[codebuddy] failed to persist refreshed credentials for "${connectionId}":`,
        error instanceof Error ? error.message : error,
      )
      schedulePersistenceRetry(connectionId)
    })
  }, REFRESH_RETRY_MS)
  timer.unref?.()
  persistenceRetryTimers.set(connectionId, timer)
}

/**
 * 从 connection 解析 token refresh URL。
 * refresh 端点为 `${origin}/v2/plugin/auth/token/refresh`，
 * 与 chat completions 共用 /v2 前缀。
 * 先剥离尾部斜杠再判断，避免 `.../v2/` 被拼成 `.../v2/v2`。
 */
function resolveCodebuddyRefreshUrl(conn: ProviderConnection): string {
  const raw = conn.baseUrl?.trim() || CODEBUDDY_DEFAULT_BASE_URL
  const base = raw.replace(/\/+$/, "")
  const withVersion = /\/v\d+$/.test(base) ? base : `${base}/v2`
  const origin = new URL(withVersion).origin
  return `${origin}/v2/plugin/auth/token/refresh`
}

/**
 * X-Domain 优先从 connection.headers 读取（大小写不敏感），否则用默认值。
 * 大小写不敏感查找可避免用户配置 `x-domain` 时与默认 `X-Domain` 重复发送。
 */
function resolveCodebuddyDomain(conn: ProviderConnection): string {
  const headers = conn.headers
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "x-domain" && value) return value
    }
  }
  return CODEBUDDY_DEFAULT_DOMAIN
}

interface CodebuddyRefreshResponse {
  code?: number
  msg?: string
  data?: {
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
    refreshExpiresIn?: number
    tokenType?: string
    domain?: string
  }
}

interface JwtPayload {
  sub?: string
  exp?: number
  [key: string]: unknown
}

/** 解码 JWT payload（仅 payload，不验签）。 */
function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const json = Buffer.from(
      parts[1].replaceAll("-", "+").replaceAll("_", "/"),
      "base64",
    ).toString("utf8")
    return JSON.parse(json) as JwtPayload
  } catch {
    return null
  }
}

function credentialExpiryMs(credential: ApiCredential): number | undefined {
  const expiresAt = credential.context?.expiresAt
  if (typeof expiresAt === "number") return expiresAt
  const jwtExpiry =
    credential.value ? decodeJwtPayload(credential.value)?.exp : undefined
  return typeof jwtExpiry === "number" ? jwtExpiry * 1000 : undefined
}

/**
 * 刷新 CodeBuddy credential。
 *
 * 直接修改 credential.value / credential.context，并持久化轮换后的 token。
 */
export async function refreshCodebuddyTokenForConnection(
  conn: ProviderConnection,
): Promise<boolean> {
  const credential = conn.credentials[0]
  if (!credential) {
    logger.warn(`[codebuddy] connection "${conn.name}" has no credential`)
    return false
  }

  const ctx = credential.context as
    | { refreshToken?: string; accountId?: string }
    | undefined
  const refreshToken = ctx?.refreshToken
  if (!refreshToken) {
    logger.warn(
      `[codebuddy] connection "${conn.name}" has no refreshToken, cannot refresh`,
    )
    return false
  }

  // X-User-Id 从旧 accessToken 的 JWT sub 提取
  const oldAccessToken = credential.value
  const userId =
    oldAccessToken ? decodeJwtPayload(oldAccessToken)?.sub : undefined

  logger.info(`[codebuddy] refreshing token for connection "${conn.name}"`)

  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${oldAccessToken ?? ""}`,
    "X-Refresh-Token": refreshToken,
    "X-Auth-Refresh-Source": "plugin",
    "X-Domain": resolveCodebuddyDomain(conn),
    "X-Product": CODEBUDDY_PRODUCT,
    "X-Request-ID": randomUUID().replaceAll("-", ""),
    "User-Agent": CODEBUDDY_USER_AGENT,
  }
  if (userId) headers["X-User-Id"] = userId

  let response: Response
  try {
    response = await fetch(resolveCodebuddyRefreshUrl(conn), {
      method: "POST",
      headers,
    })
  } catch (e) {
    logger.error(
      `[codebuddy] refresh request failed for "${conn.name}":`,
      e instanceof Error ? e.message : e,
    )
    return false
  }

  if (!response.ok) {
    logger.error(
      `[codebuddy] refresh failed for "${conn.name}": HTTP ${response.status}`,
    )
    return false
  }

  let body: CodebuddyRefreshResponse
  try {
    body = (await response.json()) as CodebuddyRefreshResponse
  } catch {
    logger.error(`[codebuddy] refresh response unparsable for "${conn.name}"`)
    return false
  }
  if (body.code !== 0 || !body.data?.accessToken) {
    logger.error(
      `[codebuddy] refresh returned error for "${conn.name}": code=${body.code} msg=${body.msg}`,
    )
    return false
  }

  const newAccessToken = body.data.accessToken
  const newRefreshToken = body.data.refreshToken ?? refreshToken
  const newExpiresAt = decodeJwtPayload(newAccessToken)?.exp
  const expiresAtMs =
    typeof newExpiresAt === "number" ? newExpiresAt * 1000 : undefined

  // 更新 credential
  credential.value = newAccessToken
  credential.context = {
    ...credential.context,
    refreshToken: newRefreshToken,
    expiresAt: expiresAtMs,
  }
  try {
    await persistProviderConnections()
  } catch (error: unknown) {
    logger.error(
      `[codebuddy] failed to persist refreshed credentials for "${conn.name}":`,
      error instanceof Error ? error.message : error,
    )
    schedulePersistenceRetry(conn.id)
  }

  logger.info(
    `[codebuddy] token refreshed for "${conn.name}", new expiry: ${expiresAtMs ? new Date(expiresAtMs).toISOString() : "unknown"}`,
  )
  return true
}

/**
 * 检查 CodeBuddy credential 是否需要刷新。
 * 在过期前 5 分钟触发。
 */
export function codebuddyNeedsRefresh(credential: ApiCredential): boolean {
  const expiresAt = credentialExpiryMs(credential)
  if (!expiresAt) return true
  return expiresAt - REFRESH_LEAD_MS <= Date.now()
}

/** 请求前按需刷新，并按 connection id 合并并发刷新。 */
export async function ensureCodebuddyAccessToken(
  conn: ProviderConnection,
  credential: ApiCredential,
): Promise<string | undefined> {
  if (!codebuddyNeedsRefresh(credential)) return credential.value || undefined
  const refreshToken = credential.context?.refreshToken
  if (typeof refreshToken !== "string" || !refreshToken) {
    return credential.value || undefined
  }

  const live = getMutableProviderConnection(conn.id)
  if (!live) return credential.value || undefined

  let refresh = inflightRefreshes.get(conn.id)
  if (!refresh) {
    refresh = refreshCodebuddyTokenForConnection(live).finally(() => {
      inflightRefreshes.delete(conn.id)
    })
    inflightRefreshes.set(conn.id, refresh)
  }
  const succeeded = await refresh
  const liveCredential = live.credentials[0]
  if (succeeded) scheduleCodebuddyRefresh(live)
  return liveCredential?.value || credential.value || undefined
}

export function cancelCodebuddyRefreshTimer(connectionId: string): void {
  const timer = refreshTimers.get(connectionId)
  if (!timer) return
  clearTimeout(timer)
  refreshTimers.delete(connectionId)
}

export function cancelAllCodebuddyRefreshTimers(): void {
  for (const connectionId of refreshTimers.keys()) {
    cancelCodebuddyRefreshTimer(connectionId)
  }
  for (const [connectionId, timer] of persistenceRetryTimers) {
    clearTimeout(timer)
    persistenceRetryTimers.delete(connectionId)
  }
}

/**
 * 安排下次自动刷新。
 */
export function scheduleCodebuddyRefresh(conn: ProviderConnection): void {
  cancelCodebuddyRefreshTimer(conn.id)
  const credential = conn.credentials[0]
  if (!credential) return
  const expiresAt = credentialExpiryMs(credential)
  if (!expiresAt) return

  const refreshInMs = Math.max(
    expiresAt - Date.now() - REFRESH_LEAD_MS,
    REFRESH_RETRY_MS,
  )
  const timerDelayMs = Math.min(refreshInMs, MAX_TIMER_DELAY_MS)
  const refreshInSeconds = Math.floor(refreshInMs / 1000)

  logger.debug(
    `[codebuddy] scheduling refresh for "${conn.name}" in ${refreshInSeconds}s`,
  )

  const timer = setTimeout(() => {
    refreshTimers.delete(conn.id)
    void (async () => {
      const mutable = getMutableProviderConnection(conn.id)
      if (!mutable || !mutable.enabled) return
      const cred = mutable.credentials[0]
      if (!cred) return
      if (!codebuddyNeedsRefresh(cred)) {
        scheduleCodebuddyRefresh(mutable)
        return
      }

      try {
        await refreshCodebuddyTokenForConnection(mutable)
      } catch (error: unknown) {
        logger.error(
          `[codebuddy] failed to persist refreshed token for "${mutable.name}":`,
          error instanceof Error ? error.message : error,
        )
      } finally {
        const current = getMutableProviderConnection(conn.id)
        // 成功时安排下一轮；临时失败时一分钟后重试。
        if (current?.enabled) scheduleCodebuddyRefresh(current)
      }
    })()
  }, timerDelayMs)
  timer.unref?.()
  refreshTimers.set(conn.id, timer)
}

export function scheduleCodebuddyRefreshForAllConnections(): void {
  for (const conn of listProviderConnections()) {
    if (conn.protocol === "codebuddy-native") scheduleCodebuddyRefresh(conn)
  }
}
