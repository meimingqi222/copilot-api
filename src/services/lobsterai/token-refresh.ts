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
 */

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections/types"

import { logger } from "~/lib/logger"
import { getMutableProviderConnection } from "~/lib/provider-connections/state"
import { parseJwtPayload } from "~/services/oauth/jwt"
import {
  lobsteraiClientVersion,
  lobsteraiServerRoot,
} from "~/services/protocols/lobsterai-native"

const REFRESH_LEAD_MS = 5 * 60 * 1000
const DEFAULT_KEYFROM = "official"

interface LobsteraiRefreshResponse {
  code?: number
  message?: string
  data?: {
    accessToken?: string
    refreshToken?: string
    userId?: string
    yid?: string
  }
}

/** credential.context 中 LobsterAI 相关字段。 */
export interface LobsteraiCredentialContext {
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
    response = await fetch(`${lobsteraiServerRoot(conn)}/api/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    })
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
  const expiresAt = jwtExpiryMs(newAccessToken)

  credential.value = newAccessToken
  credential.context = {
    ...credential.context,
    refreshToken: newRefreshToken,
    expiresAt,
    ...(payload.data.userId ? { userId: payload.data.userId } : {}),
  }

  logger.info(
    `[lobsterai] token refreshed for "${conn.name}", new expiry: ${
      expiresAt ? new Date(expiresAt).toISOString() : "unknown"
    }`,
  )
  return true
}

/** 是否需要在过期前刷新（提前 5 分钟）。 */
export function lobsteraiNeedsRefresh(credential: ApiCredential): boolean {
  const ctx = readContext(credential)
  const expiresAt = ctx.expiresAt ?? jwtExpiryMs(credential.value)
  if (!expiresAt) return true
  return expiresAt - REFRESH_LEAD_MS <= Date.now()
}

/** 安排下次自动刷新（成功后自递归）。 */
export function scheduleLobsteraiRefresh(conn: ProviderConnection): void {
  const credential = conn.credentials[0]
  if (!credential) return

  const ctx = readContext(credential)
  const expiresAt = ctx.expiresAt ?? jwtExpiryMs(credential.value)
  if (!expiresAt) return

  const refreshInMs = Math.max(expiresAt - Date.now() - REFRESH_LEAD_MS, 60_000)
  const refreshInSeconds = Math.floor(refreshInMs / 1000)

  logger.debug(
    `[lobsterai] scheduling refresh for "${conn.name}" in ${refreshInSeconds}s`,
  )

  setTimeout(async () => {
    const mutable = getMutableProviderConnection(conn.id)
    if (!mutable || !mutable.enabled) return
    const cred = mutable.credentials[0]
    if (!cred || !lobsteraiNeedsRefresh(cred)) return

    const success = await refreshLobsteraiTokenForConnection(mutable)
    if (success) {
      scheduleLobsteraiRefresh(mutable)
    }
  }, refreshInMs)
}
