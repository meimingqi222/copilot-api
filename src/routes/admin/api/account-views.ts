/**
 * Phase 4:从 ProviderConnection 派生与原 publicAccount(account) 完全一致的 JSON 视图。
 *
 * Phase 5:完全 connection 原生实现,不再经由 getAccount/connectionToAccount
 * 派生 Account 快照。所有字段直接从 ProviderConnection/ApiCredential 读取。
 *
 * 注意:本文件是 admin 视图层的 connection-native DTO 生成器。
 * availableModels 保留 AccountModel 形状(admin UI 依赖此形状)。
 */
import type { ProviderConnection } from "~/lib/provider-connections"

import { connectionModelsToAccountModels } from "~/lib/legacy-accounts"
import {
  connectionHasCredentials as connectionHasCredentialsNative,
  getConnectionAuthError,
  getConnectionAuthStatus,
  getConnectionCooldownUntil,
  getConnectionExhaustedAt,
  getConnectionQuotaInfo,
  getConnectionQuotaState,
  getConnectionSettings,
  isOAuthConnection,
  listAccountManagedConnections,
  providerFromProtocol,
  refreshConnectionAvailability,
} from "~/lib/provider-connections"
import { getRemainingCooldownSeconds } from "~/lib/rate-limit"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

/**
 * 从 ProviderConnection 派生 admin API 的 publicAccount JSON 视图。
 * 完全 connection 原生,不调用 getAccount/connectionToAccount。
 */
export function publicAccountFromConnection(conn: ProviderConnection) {
  initializeProviderRegistry()
  const provider = providerFromProtocol(conn.protocol) ?? "copilot"
  const runtime = getProviderRuntime(provider)
  const availability = getConnectionAvailabilityForAdmin(conn)
  const subtitle = connectionOAuthSubtitle(conn)
  const availableModels = connectionModelsToAccountModels(conn)
  const settings = getConnectionSettings(conn) ?? {}
  const authStatus = getConnectionAuthStatus(conn)
  const authError = getConnectionAuthError(conn)
  const quotaState = getConnectionQuotaState(conn)
  const quotaInfo = getConnectionQuotaInfo(conn)
  const exhaustedAt = getConnectionExhaustedAt(conn)

  return {
    id: conn.id,
    label: conn.name,
    subtitle,
    provider,
    availableModels,
    enabled: conn.enabled,
    priority: conn.priority,
    isExhausted:
      availability.reason === "cooldown" || availability.reason === "quota",
    exhaustedAt,
    availabilityReason: availability.reason,
    retryAfterSeconds: availability.retryAfterSeconds || null,
    quotaState: quotaState ?? "unknown",
    quotaInfo: quotaInfo ?? null,
    supportsQuota: runtime.supports(conn, "quota"),
    createdAt: conn.createdAt,
    settings,
    providerFeatures: runtime.descriptor.features,
    authStatus: authStatus ?? "ready",
    authError: authError ?? null,
    hasCredentials: connectionHasCredentialsNative(conn),
    isActive: conn.id === getActiveAccountId(),
  }
}

/**
 * 从 connection 派生可用性信息(等价 getAccountAvailability)。
 * 直接读 connection/credential 字段,不经过 Account 快照。
 */
export function getConnectionAvailabilityForAdmin(conn: ProviderConnection): {
  available: boolean
  reason: "available" | "disabled" | "cooldown" | "quota" | "error"
  retryAfterSeconds: number
} {
  // 先刷新过期的 cooldown / quota_exhausted 状态
  refreshConnectionAvailability(conn)

  if (!conn.enabled) {
    return { available: false, reason: "disabled", retryAfterSeconds: 0 }
  }

  // 鉴权错误:任一 credential 处于 auth_error 即视为不可用
  const hasAuthError = conn.credentials.some((c) => c.status === "auth_error")
  if (hasAuthError) {
    return { available: false, reason: "error", retryAfterSeconds: 10 }
  }

  // cooldown 检查(通过 rate limiter 的内存状态)
  const remainingCooldown = getRemainingCooldownSeconds(conn.id)
  if (remainingCooldown > 0) {
    return {
      available: false,
      reason: "cooldown",
      retryAfterSeconds: remainingCooldown,
    }
  }

  // 配额耗尽:任一 credential 处于 quota_exhausted
  const exhaustedCred = conn.credentials.find(
    (c) => c.status === "quota_exhausted",
  )
  if (exhaustedCred) {
    let retryAfterSeconds = 0
    // credential.cooldownUntil 已包含恢复时间(markCredentialQuotaExhausted 写入)
    if (
      exhaustedCred.cooldownUntil
      && exhaustedCred.cooldownUntil > Date.now()
    ) {
      retryAfterSeconds = Math.ceil(
        (exhaustedCred.cooldownUntil - Date.now()) / 1000,
      )
    }
    // 也检查 connection 级 cooldownUntil(持久化值)
    const connCooldownUntil = getConnectionCooldownUntil(conn)
    if (connCooldownUntil && connCooldownUntil > Date.now()) {
      const cooldownSec = Math.ceil((connCooldownUntil - Date.now()) / 1000)
      if (cooldownSec > retryAfterSeconds) {
        retryAfterSeconds = cooldownSec
      }
    }
    return { available: false, reason: "quota", retryAfterSeconds }
  }

  return { available: true, reason: "available", retryAfterSeconds: 0 }
}

/**
 * 从 connection 派生 OAuth subtitle(等价 getOAuthAccountSubtitle)。
 * 直接读 credential.context,不经过 Account 快照。
 */
export function connectionSubtitle(
  conn: ProviderConnection,
): string | undefined {
  if (!isOAuthConnection(conn)) return undefined
  return connectionOAuthSubtitle(conn)
}

/**
 * 判断 connection 是否有凭据(等价 getHasCredentials)。
 * 委托给 connection-accessors.ts 的 connection 原生实现。
 */
export function connectionHasCredentials(conn: ProviderConnection): boolean {
  return connectionHasCredentialsNative(conn)
}

/**
 * 确保 provider registry 已初始化并获取 runtime。
 */
export function ensureProviderRuntime(
  provider: Parameters<typeof getProviderRuntime>[0],
) {
  initializeProviderRegistry()
  return getProviderRuntime(provider)
}

// ── 内部辅助函数 ─────────────────────────────────────────────────

/**
 * "active" account:第一个 enabled 的 account-managed connection(按 priority 排序)。
 */
function getActiveAccountId(): string | undefined {
  const enabled = listAccountManagedConnections()
    .filter((c) => c.enabled)
    .sort((a, b) => a.priority - b.priority)
  return enabled[0]?.id
}

/**
 * 从 credential.context 派生 OAuth subtitle,镜像 getOAuthAccountSubtitle 的逻辑:
 * - email !== conn.name → email
 * - antigravity && projectId !== conn.name → projectId
 * - accountId !== conn.name → accountId
 */
function connectionOAuthSubtitle(conn: ProviderConnection): string | undefined {
  if (!isOAuthConnection(conn)) return undefined
  const cred = conn.credentials[0]
  const ctx = cred?.context
  if (!ctx) return undefined

  const email = typeof ctx.email === "string" ? ctx.email.trim() : undefined
  if (email && email !== conn.name) return email

  const projectId =
    typeof ctx.projectId === "string" ? ctx.projectId.trim() : undefined
  const provider = providerFromProtocol(conn.protocol)
  if (provider === "antigravity" && projectId && projectId !== conn.name) {
    return projectId
  }

  const oauthAccountId =
    typeof ctx.oauthAccountId === "string" ?
      ctx.oauthAccountId.trim()
    : undefined
  if (oauthAccountId && oauthAccountId !== conn.name) {
    return oauthAccountId
  }

  return undefined
}
