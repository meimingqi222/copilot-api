import { getConnectionProxyUrl } from "~/lib/provider-connections"
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

import {
  accountManagedProvider,
  connectionHasCredentials as connectionHasCredentialsNative,
  connectionModelsToAccountModels,
  getConnectionAuthError,
  getConnectionAuthStatus,
  getConnectionExhaustedAt,
  getConnectionQuotaInfo,
  getConnectionQuotaState,
  getConnectionRoutability,
  getConnectionSettings,
  isOAuthConnection,
  listAccountManagedConnections,
  refreshConnectionAvailability,
} from "~/lib/provider-connections"
import { resolveMinimaxRegion } from "~/services/oauth/minimax"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

/**
 * 从 ProviderConnection 派生 admin API 的 publicAccount JSON 视图。
 * 完全 connection 原生,不调用 getAccount/connectionToAccount。
 */
export function publicAccountFromConnection(
  conn: ProviderConnection,
  activeAccountId?: string,
) {
  initializeProviderRegistry()
  // codebuddy / codebuddy-cn 共用协议，必须用 metadata.provider 优先的派生
  const provider = accountManagedProvider(conn)
  const runtime = getProviderRuntime(provider)
  const availability = getConnectionAvailabilityForAdmin(conn)
  const subtitle = connectionOAuthSubtitle(conn)
  const availableModels = connectionModelsToAccountModels(conn)
  const settings = { ...getConnectionSettings(conn) }
  // 有效代理值(连接级 → 系统默认)。UI 用它回显，留空表示跟随默认。
  const proxyUrl = getConnectionProxyUrl(conn) ?? null
  if (provider === "claude") delete settings.claudeTransport
  if (
    provider === "claude"
    && (conn.metadata?.claudeTransport === "cli"
      || conn.metadata?.claudeTransport === "http")
  ) {
    settings.claudeTransport = conn.metadata.claudeTransport
  }
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
    // Cooldown and quota are separate states: a cooldown lifts by itself and
    // must not be presented as a terminal "quota exhausted" account.
    isExhausted: availability.reason === "quota",
    isCoolingDown: availability.reason === "cooldown",
    exhaustedAt,
    availabilityReason: availability.reason,
    retryAfterSeconds: availability.retryAfterSeconds || null,
    quotaState: quotaState ?? "unknown",
    quotaInfo: quotaInfo ?? null,
    supportsQuota: runtime.supports(conn, "quota"),
    createdAt: conn.createdAt,
    settings,
    proxyUrl,
    providerFeatures: runtime.descriptor.features,
    authStatus: authStatus ?? "ready",
    authError: authError ?? null,
    hasCredentials: connectionHasCredentialsNative(conn),
    isActive: conn.id === (activeAccountId ?? getActiveAccountId()),
  }
}

/**
 * Project a list of connections with one active-account lookup. Calling
 * `publicAccountFromConnection` per row would re-sort every connection once per
 * account (O(n² log n)) for a value that is identical across the list.
 */
export function publicAccountsFromConnections(
  connections: ReadonlyArray<ProviderConnection>,
) {
  const activeAccountId = getActiveAccountId()
  return connections.map((conn) =>
    publicAccountFromConnection(conn, activeAccountId),
  )
}

/**
 * 从 connection 派生可用性信息(等价 getAccountAvailability)。
 *
 * 判定本身交给 lib 的 `getConnectionRoutability`（Connection 可调度性的唯一
 * 定义点）；这里只做 admin 词汇映射与过期状态恢复，不再维护第二套规则。
 */
export function getConnectionAvailabilityForAdmin(conn: ProviderConnection): {
  available: boolean
  reason: "available" | "disabled" | "cooldown" | "quota" | "error"
  retryAfterSeconds: number
} {
  // 先刷新过期的 cooldown / quota_exhausted 状态
  refreshConnectionAvailability(conn)

  const routability = getConnectionRoutability(conn)
  return {
    available: routability.routable,
    reason:
      routability.reason === "auth_error" ? "error"
      : routability.reason === "quota_exhausted" ? "quota"
      : routability.reason,
    retryAfterSeconds: routability.retryAfterSeconds,
  }
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
  const provider = accountManagedProvider(conn)
  if (provider === "antigravity" && projectId && projectId !== conn.name) {
    return projectId
  }

  const oauthAccountId =
    typeof ctx.oauthAccountId === "string" ?
      ctx.oauthAccountId.trim()
    : undefined

  // MiniMax Code 的凭证按区域签发（国内版 / 国际版），同名卡片靠域名区分。
  // 域名文案中英文界面下都不会歧义。
  if (provider === "minimax") {
    return resolveMinimaxRegion(conn) === "en" ?
        "Global (minimax.io)"
      : "CN (minimax.cn)"
  }

  if (oauthAccountId && oauthAccountId !== conn.name) {
    return oauthAccountId
  }

  return undefined
}
