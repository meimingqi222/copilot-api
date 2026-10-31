/**
 * LobsterAI（有道龙虾）Token 刷新。
 *
 * LobsterAI 使用自定义的 refresh 端点（非标准 OAuth refresh_token grant）：
 *   POST {root}/api/auth/refresh
 *   Body: { refreshToken, firstKeyfrom, latestKeyfrom, uuid?, userId?, version }
 *   → { code: 0, data: { accessToken, refreshToken, userId, yid } }
 *
 * 刷新成功后旧 refreshToken 仍然有效（服务端非单次轮换），
 * 但仍以响应返回的新 token 为准。
 * 定时调度、提前量、并发合并等通用部分在 `~/services/auth/refresh-scheduler`。
 */

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections/types"

import { createLogger } from "~/lib/logger"
import { persistProviderConnections } from "~/lib/provider-connections"
import { getMutableProviderConnection } from "~/lib/provider-connections/state"
import { createTokenRefreshScheduler } from "~/services/auth/refresh-scheduler"
import { parseJwtPayload } from "~/services/oauth/jwt"
import { connectionFetchInit } from "~/services/protocols/shared"
import { lobsteraiClientVersion, lobsteraiServerRoot } from "./config"

const logger = createLogger("auth")

const DEFAULT_KEYFROM = "official"

interface LobsteraiRefreshResponse {
  code?: number
  message?: string
  data?: {
    accessToken?: string
    refreshToken?: string
    userId?: string
    yid?: string
    expiresIn?: number
  }
}

/** credential.context 中 LobsterAI 相关字段。 */
interface LobsteraiCredentialContext {
  refreshToken?: string
  expiresAt?: number
  accountId?: string
  firstKeyfrom?: string
  latestKeyfrom?: string
  uuid?: string
  userId?: string
}

function readContext(credential: ApiCredential): LobsteraiCredentialContext {
  const ctx = credential.context
  if (!ctx || typeof ctx !== "object") return {}
  return ctx as LobsteraiCredentialContext
}

/** 从 JWT `exp`（秒）解析出毫秒时间戳；失败返回 undefined。 */
function jwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined
  const payload = parseJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === "number" && Number.isFinite(exp) ?
      Math.floor(exp * 1000)
    : undefined
}

function credentialExpiryMs(credential: ApiCredential): number | undefined {
  return readContext(credential).expiresAt ?? jwtExpiryMs(credential.value)
}

/** 刷新 LobsterAI credential（直接改 credential.value / context，调用方负责持久化）。 */
export async function refreshLobsteraiTokenForConnection(
  conn: ProviderConnection,
): Promise<boolean> {
  const credential = conn.credentials[0]
  if (!credential) {
    logger.warn(`[lobsterai] connection "${conn.name}" has no credential`)
    return false
  }

  const ctx = readContext(credential)
  if (!ctx.refreshToken) {
    logger.warn(
      `[lobsterai] connection "${conn.name}" has no refreshToken, cannot refresh`,
    )
    return false
  }

  logger.info(`[lobsterai] refreshing token for connection "${conn.name}"`)

  const body: Record<string, string> = {
    refreshToken: ctx.refreshToken,
    firstKeyfrom: ctx.firstKeyfrom || DEFAULT_KEYFROM,
    latestKeyfrom: ctx.latestKeyfrom || DEFAULT_KEYFROM,
    version: lobsteraiClientVersion(conn),
  }
  if (ctx.uuid) body.uuid = ctx.uuid
  if (ctx.userId) body.userId = ctx.userId

  let response: Response
  try {
    response = await fetch(
      `${lobsteraiServerRoot(conn)}/api/auth/refresh`,
      connectionFetchInit(conn, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      }),
    )
  } catch (e) {
    logger.error(
      `[lobsterai] refresh request failed for "${conn.name}":`,
      e instanceof Error ? e.message : e,
    )
    return false
  }

  if (!response.ok) {
    logger.error(
      `[lobsterai] refresh failed for "${conn.name}": HTTP ${response.status}`,
    )
    return false
  }

  let payload: LobsteraiRefreshResponse
  try {
    payload = (await response.json()) as LobsteraiRefreshResponse
  } catch {
    logger.error(`[lobsterai] refresh response unparsable for "${conn.name}"`)
    return false
  }

  if (payload.code !== 0 || !payload.data?.accessToken) {
    logger.error(
      `[lobsterai] refresh returned error for "${conn.name}": code=${payload.code} message=${payload.message ?? ""}`,
    )
    return false
  }

  const newAccessToken = payload.data.accessToken
  const newRefreshToken = payload.data.refreshToken ?? ctx.refreshToken
  const jwtExp = jwtExpiryMs(newAccessToken)
  let expiresAt: number | undefined
  if (typeof jwtExp === "number") {
    expiresAt = jwtExp
  } else if (
    typeof payload.data.expiresIn === "number"
    && Number.isFinite(payload.data.expiresIn)
    && payload.data.expiresIn > 0
  ) {
    expiresAt = Date.now() + payload.data.expiresIn * 1000
  }

  credential.value = newAccessToken
  credential.context = {
    ...credential.context,
    refreshToken: newRefreshToken,
    expiresAt,
    ...(payload.data.userId ? { userId: payload.data.userId } : {}),
  }

  if (getMutableProviderConnection(conn.id) === conn) {
    try {
      await persistProviderConnections()
    } catch (error) {
      logger.error(
        `[lobsterai] failed to persist refreshed tokens for "${conn.name}":`,
        error,
      )
      return false
    }
  }

  logger.info(
    `[lobsterai] token refreshed for "${conn.name}", new expiry: ${
      expiresAt ? new Date(expiresAt).toISOString() : "unknown"
    }`,
  )
  return true
}

const scheduler = createTokenRefreshScheduler({
  scope: "lobsterai",
  jobLabel: "LobsterAI token refresh",
  protocol: "lobsterai-native",
  refresh: (conn) => refreshLobsteraiTokenForConnection(conn),
  expiryMs: credentialExpiryMs,
  // 有 refreshToken 即可调度；LobsterAI 的定时刷新不因 enabled 开关停止
  // （禁用的连接仍会在 token 过期后继续尝试刷新，这是既有行为）。
  canSchedule: (_conn, credential) =>
    Boolean(readContext(credential).refreshToken),
  canRefresh: (credential) => Boolean(readContext(credential).refreshToken),
  // 定时刷新与请求前刷新共用同一张 in-flight 表。
  dedupeScheduledRefresh: true,
  // 请求前刷新以内存中的最新凭据为准（可能已被定时刷新轮换过），并返回
  // 按 id 命中的那份。
  ensure: { gate: "live", result: "by-id" },
})

/** Request-time refresh also covers imported tokens and a missed timer. */
export function ensureLobsteraiAccessToken(
  conn: ProviderConnection,
  credential: ApiCredential,
): Promise<string | undefined> {
  return scheduler.ensureAccessToken(conn, credential)
}

export function cancelLobsteraiRefreshTimer(connectionId: string): void {
  scheduler.cancel(connectionId)
}

/** 安排下次自动刷新；瞬时失败后继续重试。 */
export function scheduleLobsteraiRefresh(conn: ProviderConnection): void {
  scheduler.schedule(conn)
}

export function scheduleLobsteraiRefreshForAllConnections(): void {
  scheduler.scheduleAll()
}
