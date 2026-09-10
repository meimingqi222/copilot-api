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
import { getMutableProviderConnection } from "~/lib/provider-connections/state"

const CODEBUDDY_REFRESH_URL =
  "https://copilot.tencent.com/v2/plugin/auth/token/refresh"
const CODEBUDDY_USER_AGENT = "CLI/2.148.0 CodeBuddy/2.148.0"
const CODEBUDDY_DOMAIN = "www.codebuddy.cn"
const CODEBUDDY_PRODUCT = "SaaS"
const REFRESH_LEAD_MS = 5 * 60 * 1000

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

/**
 * 刷新 CodeBuddy credential。
 *
 * 直接修改 credential.value / credential.context，
 * 调用方负责持久化（saveProviderConnections）。
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
    "X-Domain": CODEBUDDY_DOMAIN,
    "X-Product": CODEBUDDY_PRODUCT,
    "X-Request-ID": randomUUID().replaceAll("-", ""),
    "User-Agent": CODEBUDDY_USER_AGENT,
  }
  if (userId) headers["X-User-Id"] = userId

  let response: Response
  try {
    response = await fetch(CODEBUDDY_REFRESH_URL, {
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

  const body = (await response.json()) as CodebuddyRefreshResponse
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
  const ctx = credential.context as { expiresAt?: number } | undefined
  if (!ctx?.expiresAt) return true
  return ctx.expiresAt - REFRESH_LEAD_MS <= Date.now()
}

/**
 * 安排下次自动刷新。
 */
export function scheduleCodebuddyRefresh(conn: ProviderConnection): void {
  const credential = conn.credentials[0]
  if (!credential) return
  const ctx = credential.context as { expiresAt?: number } | undefined
  if (!ctx?.expiresAt) return

  const refreshInMs = Math.max(
    ctx.expiresAt - Date.now() - REFRESH_LEAD_MS,
    60_000,
  )
  const refreshInSeconds = Math.floor(refreshInMs / 1000)

  logger.debug(
    `[codebuddy] scheduling refresh for "${conn.name}" in ${refreshInSeconds}s`,
  )

  setTimeout(async () => {
    const mutable = getMutableProviderConnection(conn.id)
    if (!mutable || !mutable.enabled) return
    const cred = mutable.credentials[0]
    if (!cred || !codebuddyNeedsRefresh(cred)) return

    const success = await refreshCodebuddyTokenForConnection(mutable)
    if (success) {
      // 递归安排下次刷新
      scheduleCodebuddyRefresh(mutable)
    }
  }, refreshInMs)
}
