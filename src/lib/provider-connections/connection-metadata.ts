/**
 * AccountLegacyMetadata 类型化读取器。
 *
 * Step D 迁移后，原 Account 的 provider-specific 字段（quotaInfo、settings、
 * credentialExtras 等）承载于 `ProviderConnection.metadata` 内的
 * `AccountLegacyMetadata` 子结构。本模块提供类型安全的字段读取器，
 * 替代散装 `metadata.xxx as string` 强转。
 */
import type { Account, AccountQuotaState, QuotaSnapshot } from "~/lib/accounts"

import { isOAuthProviderId, type ProviderId } from "~/lib/provider-config"

import type { ProviderConnection } from "./types"

/**
 * 迁移后 provider-connections.json 中 migrated connection 的 metadata 形状。
 *
 * 原 Account 顶层字段（除 id/label/enabled/priority/createdAt 已映射到
 * ProviderConnection 标准字段外）的承载区。
 */
export interface AccountLegacyMetadata {
  // ── 原 Account 顶层字段 ──
  provider: ProviderId
  quotaState: AccountQuotaState
  quotaInfo?: QuotaSnapshot | null
  quotaExhaustedAt?: number
  exhaustedAt?: number
  cooldownUntil?: number
  lastRateLimitAt?: number
  lastRateLimitReason?: string
  isExhausted?: boolean
  // OAuth-specific
  cpaMetadata?: Record<string, unknown>
  subtitle?: string
  // provider-specific settings（原 account.settings）
  settings?: Record<string, unknown>
  // provider-specific credentials extras（非 token 字段）
  // 如 mimo 的 xiaomichatbotPh / mimoWsToken
  // OAuth 的 email / accountId / projectId / deviceId / apiKey / idToken / refreshToken
  credentialExtras?: Record<string, unknown>
  // admin-only 视图字段
  authStatus?: string
  authError?: string | null
  // OAuth routing 字段（从 settings 提取到 metadata 顶层供 routing 读取）
  proxyUrl?: string
  modelPrefix?: string
  tokenEndpoint?: string
  redirectUri?: string
  // mimo routing 字段
  proxy?: string
  userId?: string
}

/**
 * 从 connection.metadata 读取 AccountLegacyMetadata。
 * 若 metadata 不存在或不包含 legacy 字段，返回 undefined。
 */
export function readAccountLegacyMetadata(
  connection: ProviderConnection,
): AccountLegacyMetadata | undefined {
  const meta = connection.metadata
  if (!meta || typeof meta !== "object") return undefined
  if (!("provider" in meta)) return undefined
  return meta as unknown as AccountLegacyMetadata
}

// ── 类型安全的字段读取器 ──────────────────────────────────────────

export function getConnectionProvider(
  conn: ProviderConnection,
): ProviderId | undefined {
  return readAccountLegacyMetadata(conn)?.provider
}

export function getConnectionQuotaState(
  conn: ProviderConnection,
): AccountQuotaState {
  return readAccountLegacyMetadata(conn)?.quotaState ?? "unknown"
}

export function getConnectionQuotaInfo(
  conn: ProviderConnection,
): QuotaSnapshot | undefined {
  const meta = readAccountLegacyMetadata(conn)
  if (!meta) return undefined
  const info = meta.quotaInfo
  return info ?? undefined
}

export function getConnectionQuotaExhaustedAt(
  conn: ProviderConnection,
): number | undefined {
  return readAccountLegacyMetadata(conn)?.quotaExhaustedAt
}

export function getConnectionExhaustedAt(
  conn: ProviderConnection,
): number | undefined {
  return readAccountLegacyMetadata(conn)?.exhaustedAt
}

export function getConnectionCooldownUntil(
  conn: ProviderConnection,
): number | undefined {
  // cooldownUntil 同时存在于 credential.cooldownUntil 和 metadata.cooldownUntil
  // 优先读 credential（运行时状态），回退到 metadata（持久化值）
  const cred = conn.credentials[0]
  return cred.cooldownUntil ?? readAccountLegacyMetadata(conn)?.cooldownUntil
}

export function getConnectionLastRateLimitAt(
  conn: ProviderConnection,
): number | undefined {
  return readAccountLegacyMetadata(conn)?.lastRateLimitAt
}

export function getConnectionLastRateLimitReason(
  conn: ProviderConnection,
): string | undefined {
  return readAccountLegacyMetadata(conn)?.lastRateLimitReason
}

export function getConnectionIsExhausted(
  conn: ProviderConnection,
): boolean | undefined {
  return readAccountLegacyMetadata(conn)?.isExhausted
}

export function getConnectionCpaMetadata(
  conn: ProviderConnection,
): Record<string, unknown> | undefined {
  return readAccountLegacyMetadata(conn)?.cpaMetadata
}

export function getConnectionSubtitle(
  conn: ProviderConnection,
): string | undefined {
  return readAccountLegacyMetadata(conn)?.subtitle
}

export function getConnectionSettings(
  conn: ProviderConnection,
): Record<string, unknown> | undefined {
  return readAccountLegacyMetadata(conn)?.settings
}

export function getConnectionCredentialExtras(
  conn: ProviderConnection,
): Record<string, unknown> | undefined {
  return readAccountLegacyMetadata(conn)?.credentialExtras
}

export function getConnectionAuthStatus(conn: ProviderConnection): string {
  return readAccountLegacyMetadata(conn)?.authStatus ?? "ready"
}

export function getConnectionAuthError(
  conn: ProviderConnection,
): string | null {
  return readAccountLegacyMetadata(conn)?.authError ?? null
}

export function getConnectionProxyUrl(
  conn: ProviderConnection,
): string | undefined {
  return readAccountLegacyMetadata(conn)?.proxyUrl
}

export function getConnectionModelPrefix(
  conn: ProviderConnection,
): string | undefined {
  return readAccountLegacyMetadata(conn)?.modelPrefix
}

export function getConnectionTokenEndpoint(
  conn: ProviderConnection,
): string | undefined {
  return readAccountLegacyMetadata(conn)?.tokenEndpoint
}

export function getConnectionRedirectUri(
  conn: ProviderConnection,
): string | undefined {
  return readAccountLegacyMetadata(conn)?.redirectUri
}

export function getConnectionProxy(
  conn: ProviderConnection,
): string | undefined {
  return readAccountLegacyMetadata(conn)?.proxy
}

export function getConnectionUserId(
  conn: ProviderConnection,
): string | undefined {
  return readAccountLegacyMetadata(conn)?.userId
}

/**
 * 从 credentialExtras 读取特定字段（类型安全）。
 */
export function getCredentialExtraString(
  conn: ProviderConnection,
  key: string,
): string | undefined {
  const extras = getConnectionCredentialExtras(conn)
  if (!extras) return undefined
  const value = extras[key]
  return typeof value === "string" ? value : undefined
}

/**
 * 从 credentialExtras 读取特定字段（number 版本）。
 */
export function getCredentialExtraNumber(
  conn: ProviderConnection,
  key: string,
): number | undefined {
  const extras = getConnectionCredentialExtras(conn)
  if (!extras) return undefined
  const value = extras[key]
  return typeof value === "number" ? value : undefined
}

/**
 * 从 credential.context 读取字段（刷新源材料）。
 */
export function getCredentialContextString(
  conn: ProviderConnection,
  key: string,
): string | undefined {
  const cred = conn.credentials[0]
  if (!cred.context) return undefined
  const value = cred.context[key]
  return typeof value === "string" ? value : undefined
}

export function getCredentialContextNumber(
  conn: ProviderConnection,
  key: string,
): number | undefined {
  const cred = conn.credentials[0]
  if (!cred.context) return undefined
  const value = cred.context[key]
  return typeof value === "number" ? value : undefined
}

/**
 * 从 Account 构建完整的 AccountLegacyMetadata（供 accountToConnectionForPersistence 使用）。
 */

/**
 * 返回 provider 对应的 primary token 字段名（credential.value 的来源）。
 * 该字段不放入 credentialExtras（它在 credential.value 或 context 中）。
 */
function getPrimaryTokenKey(provider: string): string | undefined {
  switch (provider) {
    case "copilot": {
      return "githubToken"
    }
    case "codebuff": {
      return "authToken"
    }
    case "windsurf": {
      return "apiKey"
    }
    case "mimo-aistudio": {
      return "serviceToken"
    }
    default: {
      if (isOAuthProviderId(provider as never)) return "accessToken"
      return undefined
    }
  }
}

export function buildAccountLegacyMetadata(
  account: Account,
): AccountLegacyMetadata {
  const meta: AccountLegacyMetadata = {
    provider: account.provider,
    authStatus: account.runtimeState?.authStatus ?? "ready",
    authError: account.runtimeState?.lastError ?? null,
    exhaustedAt: account.exhaustedAt,
    isExhausted: account.isExhausted,
    quotaState: account.quotaState ?? "unknown",
    quotaInfo: account.quotaInfo ?? null,
    quotaExhaustedAt: account.quotaExhaustedAt,
    cooldownUntil: account.cooldownUntil,
    lastRateLimitAt: account.lastRateLimitAt,
    lastRateLimitReason: account.lastRateLimitReason,
    settings: account.settings ?? {},
  }

  // credentialExtras: 非 primary token 的 credentials 字段
  // primary token 字段按 provider 区分：
  //   copilot→githubToken / codebuff→authToken / windsurf→apiKey /
  //   mimo→serviceToken / OAuth→accessToken
  // 其余 credentials 字段（如 OAuth 的 refreshToken/idToken/expiresAt/
  // accountId/projectId/deviceId/apiKey/email / mimo 的 xiaomichatbotPh/mimoWsToken）
  // 放入 credentialExtras 供 connectionToAccount 反构造。
  const primaryTokenKey = getPrimaryTokenKey(account.provider)
  const extras: Record<string, unknown> = {}
  if (account.credentials) {
    for (const [key, value] of Object.entries(account.credentials)) {
      if (key === primaryTokenKey) continue
      if (value !== undefined) {
        extras[key] = value
      }
    }
  }
  if (Object.keys(extras).length > 0) {
    meta.credentialExtras = extras
  }

  // OAuth-specific
  if (account.cpaMetadata) {
    meta.cpaMetadata = account.cpaMetadata
  }

  // OAuth routing 字段从 settings 提取到 metadata 顶层
  const settings = account.settings
  if (settings) {
    if (typeof settings.proxyUrl === "string") meta.proxyUrl = settings.proxyUrl
    if (typeof settings.modelPrefix === "string") {
      meta.modelPrefix = settings.modelPrefix
    }
    if (typeof settings.tokenEndpoint === "string") {
      meta.tokenEndpoint = settings.tokenEndpoint
    }
    if (typeof settings.redirectUri === "string") {
      meta.redirectUri = settings.redirectUri
    }
    // mimo-specific
    if (typeof settings.proxy === "string") meta.proxy = settings.proxy
    if (typeof settings.userId === "string") meta.userId = settings.userId
  }

  return meta
}
