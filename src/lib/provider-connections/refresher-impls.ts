import type { ApiCredential } from "~/lib/provider-connections/types"

import { refreshCopilotToken } from "~/lib/account-store"
/**
 * CredentialRefresher 实现。
 *
 * 设计决策:本阶段(3.1)以适配器形式实现,内部委托现有的
 * refreshCopilotToken / refreshOAuthAccountToken。这些函数已深度集成
 * state.accounts / saveAccounts / tokenRefreshTimers,完全重写会破坏
 * 现有功能。适配器让 connection 模型支持 refresher 接口,同时保留
 * Account 作为写入源(符合 3.2 Step A 的"读适配 + 单一写入源"策略)。
 *
 * credential.context.accountId 用于反查 state.accounts 中的 Account。
 */
import { logger } from "~/lib/logger"
import { state } from "~/lib/state"
import {
  refreshOAuthAccountToken,
  scheduleOAuthRefreshForAccount,
} from "~/services/oauth/refresh-scheduler"

import {
  getCredentialRefresher,
  registerCredentialRefresher,
  type CredentialRefresher,
} from "./credential-refresher"

const REFRESH_LEAD_MS = 5 * 60 * 1000

function findAccountById(accountId: string) {
  return state.accounts.find((a) => a.id === accountId)
}

function getAccountId(credential: ApiCredential): string | undefined {
  const ctx = credential.context
  if (!ctx || typeof ctx !== "object") return undefined
  const id = ctx.accountId
  return typeof id === "string" ? id : undefined
}

// ── CopilotTokenRefresher ────────────────────────────────────────

const copilotRefresher: CredentialRefresher = {
  type: "copilot-token",

  async refresh(credential: ApiCredential): Promise<void> {
    const accountId = getAccountId(credential) ?? credential.id
    const account = findAccountById(accountId)
    if (!account || account.provider !== "copilot" || !account.enabled) return
    await refreshCopilotToken(account)
    // 同步回 credential.value / context(供 connection 路径下次读取)
    const token = account.runtimeState?.copilotToken
    if (token) {
      credential.value = token
      credential.context = {
        ...credential.context,
        githubToken: account.credentials?.githubToken,
        copilotTokenExpiry: account.runtimeState?.copilotTokenExpiry,
        accountId,
      }
    }
  },

  needsRefresh(credential: ApiCredential): boolean {
    const ctx = credential.context as
      | { copilotTokenExpiry?: number }
      | undefined
    if (!ctx?.copilotTokenExpiry) return true
    return ctx.copilotTokenExpiry - REFRESH_LEAD_MS <= Date.now()
  },

  scheduleNextRefresh(_credential: ApiCredential): void {
    // refreshCopilotToken 内部已通过 tokenRefreshTimers 调度下次刷新,
    // 无需在此重复调度。保留方法以满足接口契约。
  },
}

// ── OAuthTokenRefresher ──────────────────────────────────────────

const oauthRefresher: CredentialRefresher = {
  type: "oauth-token",

  async refresh(credential: ApiCredential): Promise<void> {
    const accountId = getAccountId(credential) ?? credential.id
    const account = findAccountById(accountId)
    if (!account || !account.enabled) return
    await refreshOAuthAccountToken(account, "connection-driven")
    // 同步回 credential.value / context
    // account.credentials.accessToken 由各 OAuth provider bundle 已设置
    const accessToken = (account as { credentials?: { accessToken?: string } })
      .credentials?.accessToken
    if (accessToken) {
      credential.value = accessToken
      credential.context = {
        ...credential.context,
        refreshToken: (account as { credentials?: { refreshToken?: string } })
          .credentials?.refreshToken,
        expiresAt: (account as { credentials?: { expiresAt?: number } })
          .credentials?.expiresAt,
        accountId,
      }
    }
  },

  needsRefresh(credential: ApiCredential): boolean {
    const ctx = credential.context as { expiresAt?: number } | undefined
    if (!ctx?.expiresAt) return true
    return ctx.expiresAt - REFRESH_LEAD_MS <= Date.now()
  },

  scheduleNextRefresh(credential: ApiCredential): void {
    const accountId = getAccountId(credential) ?? credential.id
    const account = findAccountById(accountId)
    if (!account) return
    scheduleOAuthRefreshForAccount(account)
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
