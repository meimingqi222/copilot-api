/**
 * CredentialRefresher 实现(Phase 3 终态)。
 *
 * Phase 3 之前以适配器形式委托 refreshCopilotToken / refreshOAuthAccountToken
 * (内部反查 state.accounts)。Phase 3 完成后,所有刷新路径直调 connection 原生
 * 实现(refreshCopilotTokenForConnection / refreshOAuthConnectionToken),
 * credential.value / credential.context 为唯一真相,不再反查 Account。
 */
import type { ApiCredential } from "~/lib/provider-connections/types"

import { logger } from "~/lib/logger"
import {
  refreshCopilotTokenForConnection,
  scheduleConnectionTokenRefresh,
} from "~/services/copilot/token-refresh"
import {
  refreshOAuthConnectionToken,
  scheduleOAuthRefreshForConnection,
} from "~/services/oauth/refresh-scheduler"

import {
  getCredentialRefresher,
  registerCredentialRefresher,
  type CredentialRefresher,
} from "./credential-refresher"
import { getMutableProviderConnection } from "./state"

const REFRESH_LEAD_MS = 5 * 60 * 1000

function getConnectionId(credential: ApiCredential): string | undefined {
  const ctx = credential.context
  if (!ctx || typeof ctx !== "object") return undefined
  const id = ctx.accountId
  return typeof id === "string" ? id : undefined
}

// ── CopilotTokenRefresher ────────────────────────────────────────

const copilotRefresher: CredentialRefresher = {
  type: "copilot-token",

  async refresh(credential: ApiCredential): Promise<void> {
    const connectionId = getConnectionId(credential) ?? credential.id
    const conn = getMutableProviderConnection(connectionId)
    if (!conn || conn.protocol !== "copilot-native" || !conn.enabled) return
    // refreshCopilotTokenForConnection 直接写 credential.value +
    // context.copilotTokenExpiry,无需再手动同步回 credential。
    await refreshCopilotTokenForConnection(conn)
  },

  needsRefresh(credential: ApiCredential): boolean {
    const ctx = credential.context as
      | { copilotTokenExpiry?: number }
      | undefined
    if (!ctx?.copilotTokenExpiry) return true
    return ctx.copilotTokenExpiry - REFRESH_LEAD_MS <= Date.now()
  },

  scheduleNextRefresh(credential: ApiCredential): void {
    const connectionId = getConnectionId(credential) ?? credential.id
    const ctx = credential.context as
      | { copilotTokenExpiry?: number }
      | undefined
    if (!ctx?.copilotTokenExpiry) return
    const refreshInSeconds = Math.max(
      Math.floor((ctx.copilotTokenExpiry - Date.now()) / 1000),
      60,
    )
    scheduleConnectionTokenRefresh(connectionId, refreshInSeconds)
  },
}

// ── OAuthTokenRefresher ──────────────────────────────────────────

const oauthRefresher: CredentialRefresher = {
  type: "oauth-token",

  async refresh(credential: ApiCredential): Promise<void> {
    const connectionId = getConnectionId(credential) ?? credential.id
    const conn = getMutableProviderConnection(connectionId)
    if (!conn || !conn.enabled) return
    // refreshOAuthConnectionToken 直接写 credential.value / context /
    // metadata.authStatus,无需再手动同步回 credential。
    await refreshOAuthConnectionToken(conn, "connection-driven")
  },

  needsRefresh(credential: ApiCredential): boolean {
    const ctx = credential.context as { expiresAt?: number } | undefined
    if (!ctx?.expiresAt) return true
    return ctx.expiresAt - REFRESH_LEAD_MS <= Date.now()
  },

  scheduleNextRefresh(credential: ApiCredential): void {
    const connectionId = getConnectionId(credential) ?? credential.id
    const conn = getMutableProviderConnection(connectionId)
    if (!conn) return
    scheduleOAuthRefreshForConnection(conn)
  },
}

// ── WindsurfJwtRefresher(占位,Windsurf JWT 刷新由 mimo/windsurf manager 处理) ──

const windsurfJwtRefresher: CredentialRefresher = {
  type: "windsurf-jwt",
  async refresh(_credential: ApiCredential): Promise<void> {
    // Windsurf JWT 刷新由 services/windsurf 模块独立管理(类似 mimo manager),
    // 此处不做任何操作,保留接口契约。
  },
  needsRefresh(_credential: ApiCredential): boolean {
    return false
  },
  scheduleNextRefresh(_credential: ApiCredential): void {},
}

// ── StaticRefresher(无刷新需求) ─────────────────────────────────

const staticRefresher: CredentialRefresher = {
  type: "static",
  async refresh() {},
  needsRefresh() {
    return false
  },
  scheduleNextRefresh() {},
}

// ── 注册 ──────────────────────────────────────────────────────────

let initialized = false

export function initializeCredentialRefreshers(): void {
  if (initialized) return
  registerCredentialRefresher(copilotRefresher)
  registerCredentialRefresher(oauthRefresher)
  registerCredentialRefresher(windsurfJwtRefresher)
  registerCredentialRefresher(staticRefresher)
  initialized = true
  logger.debug("[credential-refresher] Registered 4 refresher implementations")
}

export function getCredentialRefresherByType(type: string) {
  return getCredentialRefresher(type as CredentialRefresher["type"])
}
