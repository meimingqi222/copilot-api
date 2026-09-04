/**
 * Copilot token 的 connection 原生刷新(Phase 2a)。
 *
 * Phase 2 之前的热路径:`connection → account(通过 connectionToAccount
 * 派生)→ refreshCopilotToken(account) → syncAccountToConnection`。本模块直接以
 * ProviderConnection/ApiCredential 为事实源:
 * - githubToken 从 `credential.context.githubToken` 读取
 * - copilotToken 写入 `credential.value`
 * - 过期时间写入 `credential.context.copilotTokenExpiry`
 * - 定时器以 connectionId 为键
 *
 * `account-store.ts` 中的 `refreshCopilotToken(account)` 仍服务控制路径
 * (启动调度/管理端手动刷新),Phase 3 统一收编到本模块。
 */

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { GITHUB_API_BASE_URL, githubApiHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  persistProviderConnections,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"

const TOKEN_REFRESH_RETRY_DELAY_MS = 60_000

const tokenRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const tokenRefreshRetries = new Map<string, ReturnType<typeof setTimeout>>()

function readGithubToken(credential: ApiCredential): string | undefined {
  const token = credential.context?.githubToken
  return typeof token === "string" && token ? token : undefined
}

export function copilotTokenFromCredential(
  credential: ApiCredential,
): string | undefined {
  return credential.value || undefined
}

/**
 * 刷新 connection 的 Copilot token 并持久化。
 * 非 copilot 协议或禁用的 connection 直接返回(镜像 refreshCopilotToken 门禁)。
 */
export async function refreshCopilotTokenForConnection(
  connection: ProviderConnection,
): Promise<void> {
  if (connection.protocol !== "copilot-native" || !connection.enabled) {
    return
  }

  const credential = connection.credentials[0]
  const githubToken = readGithubToken(credential)
  if (!githubToken) {
    // No token yet — connection can be completed later via Web UI
    return
  }

  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: {
        ...githubApiHeaders(),
        authorization: `token ${githubToken}`,
      },
    },
  )

  if (!response.ok) {
    const body = await response.text()
    throw new HTTPError(
      "Failed to get Copilot token for connection",
      response,
      body,
    )
  }

  const data = (await response.json()) as {
    token: string
    expires_at: number
    refresh_in: number
  }

  credential.value = data.token
  credential.context = {
    ...credential.context,
    copilotTokenExpiry: data.expires_at * 1000,
  }
  await persistProviderConnections()

  if (state.showToken) {
    logger.info(`Copilot token for "${connection.name}":`, data.token)
  }

  scheduleConnectionTokenRefresh(connection.id, data.refresh_in)
}

export function scheduleConnectionTokenRefresh(
  connectionId: string,
  refreshInSeconds: number,
): void {
  const refreshInterval = Math.max((refreshInSeconds - 60) * 1000, 60_000)
  const existingTimer = tokenRefreshTimers.get(connectionId)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const timerId = setTimeout(() => {
    tokenRefreshTimers.delete(connectionId)
    const conn = getMutableProviderConnection(connectionId)
    if (!conn || !conn.enabled) {
      tokenRefreshTimers.delete(connectionId)
      return
    }

    logger.debug(`Refreshing Copilot token for "${conn.name}"`)
    refreshCopilotTokenForConnection(conn).catch((error: unknown) => {
      logger.error(`Failed to refresh Copilot token for "${conn.name}":`, error)
      scheduleConnectionTokenRefreshRetry(connectionId)
    })
  }, refreshInterval)

  tokenRefreshTimers.set(connectionId, timerId)
}

function scheduleConnectionTokenRefreshRetry(connectionId: string): void {
  const existingRetry = tokenRefreshRetries.get(connectionId)
  if (existingRetry) {
    clearTimeout(existingRetry)
  }
  const retryTimerId = setTimeout(() => {
    tokenRefreshRetries.delete(connectionId)
    const conn = getMutableProviderConnection(connectionId)
    if (!conn || !conn.enabled) {
      tokenRefreshRetries.delete(connectionId)
      return
    }
    refreshCopilotTokenForConnection(conn).catch((error: unknown) => {
      logger.error(`Token refresh retry failed for "${conn.name}":`, error)
      scheduleConnectionTokenRefreshRetry(connectionId)
    })
  }, TOKEN_REFRESH_RETRY_DELAY_MS)
  tokenRefreshRetries.set(connectionId, retryTimerId)
}

/**
 * 兜底刷新 Copilot token(credential 式,Phase 2a)。
 *
 * copilotToken 的内存真相是 credential.value。若启动时刷新失败或定时器
 * 未及时刷新,dispatch 时 credential.value 可能为空。此处在调用上游前做
 * 一次惰性刷新,避免 "Copilot token not found" 被误判为 rate-limit 冷却
 * 形成恶性循环。
 *
 * 刷新后仍无 token(如 githubToken 缺失或 connection disabled)时抛
 * HTTPError 而非普通 Error —— 普通 Error 会被 markCooldown 误判为
 * !isHttp 网络错误走 rate-limit 冷却。503 server_error 会触发 failover
 * 但不冷却当前账号(pitfalls D.4)。
 */
export async function ensureCopilotToken(
  connection: ProviderConnection,
  credential: ApiCredential,
): Promise<void> {
  if (connection.protocol !== "copilot-native") return
  if (copilotTokenFromCredential(credential)) return
  logger.debug(
    `[copilot-native] Copilot token missing for "${connection.name}", refreshing on-demand`,
  )
  await refreshCopilotTokenForConnection(connection)
  if (!copilotTokenFromCredential(credential)) {
    throw new HTTPError(
      `Copilot token unavailable for "${connection.name}"`,
      new Response("Copilot token unavailable", { status: 503 }),
    )
  }
}

export function cancelConnectionTokenRefresh(connectionId: string): void {
  const timer = tokenRefreshTimers.get(connectionId)
  if (timer) {
    clearTimeout(timer)
    tokenRefreshTimers.delete(connectionId)
  }
  const retry = tokenRefreshRetries.get(connectionId)
  if (retry) {
    clearTimeout(retry)
    tokenRefreshRetries.delete(connectionId)
  }
}
