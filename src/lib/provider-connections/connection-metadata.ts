/**
 * AccountLegacyMetadata 类型化读取器。
 *
 * Step D 迁移后，原 Account 的 provider-specific 字段（quotaInfo、settings、
 * credentialExtras 等）承载于 `ProviderConnection.metadata` 内的
 * `AccountLegacyMetadata` 子结构。本模块提供类型安全的字段读取器，
 * 替代散装 `metadata.xxx as string` 强转。
 */
import type {
  Account,
  AccountModel,
  AccountQuotaState,
  AccountRuntimeState,
  QuotaSnapshot,
} from "~/lib/accounts"

import { isOAuthAccount } from "~/lib/accounts"
import { isOAuthProviderId, type ProviderId } from "~/lib/provider-config"

import type {
  ApiCredential,
  ModelEndpoint,
  ModelMapping,
  ProviderConnection,
} from "./types"

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

// ── 批次 2：Connection 级别写入器（替代 Account in-place mutation） ──
// 这些函数直接修改 ProviderConnection 的 metadata / credential 字段，
// 替代原来对 Account 对象的 in-place mutation。
// 调用方负责后续 persistProviderConnections() 持久化。

/**
 * 确保 connection.metadata 存在且包含 AccountLegacyMetadata 基础字段。
 * 若 metadata 不存在，创建空壳。
 */
export function ensureLegacyMetadata(
  conn: ProviderConnection,
): AccountLegacyMetadata {
  if (
    !conn.metadata
    || typeof conn.metadata !== "object"
    || !("provider" in conn.metadata)
  ) {
    conn.metadata = {
      provider: "copilot" as ProviderId,
      quotaState: "unknown",
      ...conn.metadata,
    }
  }
  return conn.metadata as unknown as AccountLegacyMetadata
}

/** 设置 metadata.cooldownUntil + credential.cooldownUntil（同步）。 */
export function setConnectionCooldownUntil(
  conn: ProviderConnection,
  value: number | undefined,
): void {
  const meta = ensureLegacyMetadata(conn)
  meta.cooldownUntil = value
  conn.credentials[0].cooldownUntil = value
}

/** 设置 metadata.quotaState + quotaExhaustedAt。 */
export function setConnectionQuotaState(
  conn: ProviderConnection,
  quotaState: AccountQuotaState,
): void {
  const meta = ensureLegacyMetadata(conn)
  meta.quotaState = quotaState
  meta.quotaExhaustedAt = quotaState === "exhausted" ? Date.now() : undefined
}

/** 设置 metadata.isExhausted + exhaustedAt。 */
export function setConnectionExhausted(
  conn: ProviderConnection,
  isExhausted: boolean,
  exhaustedAt?: number,
): void {
  const meta = ensureLegacyMetadata(conn)
  meta.isExhausted = isExhausted
  meta.exhaustedAt =
    !isExhausted ? undefined : (exhaustedAt ?? meta.exhaustedAt)
}

/** 设置 metadata.lastRateLimitAt + lastRateLimitReason。 */
export function setConnectionRateLimitInfo(
  conn: ProviderConnection,
  at: number | undefined,
  reason: string | undefined,
): void {
  const meta = ensureLegacyMetadata(conn)
  meta.lastRateLimitAt = at
  meta.lastRateLimitReason = reason
}

/** 设置 metadata.authStatus + authError。 */
export function setConnectionAuthStatus(
  conn: ProviderConnection,
  status: string | undefined,
  error?: string | null,
): void {
  const meta = ensureLegacyMetadata(conn)
  meta.authStatus = status ?? "ready"
  meta.authError = error ?? null
  const cred = conn.credentials[0]
  if (status === "error") {
    cred.status = "auth_error"
    cred.lastError = error ?? undefined
  } else if (cred.status === "auth_error") {
    cred.status = cred.enabled ? "ready" : "disabled"
    cred.lastError = undefined
  }
}

/** 设置 credential.value（运行时 token，如 copilotToken / accessToken）。 */
export function setCredentialValue(
  conn: ProviderConnection,
  value: string | undefined,
): void {
  conn.credentials[0].value = value ?? ""
}

/** 设置 credential.context 中的字段。 */
export function setCredentialContextField(
  conn: ProviderConnection,
  key: string,
  value: string | number | undefined,
): void {
  const cred = conn.credentials[0]
  if (!cred.context) cred.context = {}
  if (value === undefined) {
    cred.context = removeFromRecord(cred.context, key)
  } else {
    cred.context[key] = value
  }
}

/** 设置 metadata.settings 中的字段。 */
export function setConnectionSetting(
  conn: ProviderConnection,
  key: string,
  value: string | undefined,
): void {
  const meta = ensureLegacyMetadata(conn)
  if (!meta.settings) meta.settings = {}
  if (value === undefined) {
    meta.settings = removeFromRecord(meta.settings, key)
  } else {
    meta.settings[key] = value
  }
}

/** 设置 metadata.credentialExtras 中的字段。 */
export function setConnectionCredentialExtra(
  conn: ProviderConnection,
  key: string,
  value: string | undefined,
): void {
  const meta = ensureLegacyMetadata(conn)
  if (!meta.credentialExtras) meta.credentialExtras = {}
  if (value === undefined) {
    meta.credentialExtras = removeFromRecord(meta.credentialExtras, key)
  } else {
    meta.credentialExtras[key] = value
  }
}

/** 从 record 中移除指定 key（避免 dynamic delete lint）。 */
function removeFromRecord<T extends Record<string, unknown>>(
  record: T,
  key: string,
): T {
  const { [key]: _, ...rest } = record
  return rest as T
}

/**
 * 将 Account 的完整状态同步回 connection（in-place mutation）。
 *
 * 这是 `accountToConnectionForPersistence` 的 in-place 等价物：将 Account 的
 * 所有字段（含 credentialExtras、OAuth token、availableModels、cpaMetadata、
 * routing 字段等）同步到现有 connection，确保后续 saveProviderConnections()
 * 持久化的内容与 Account 完全一致。
 *
 * 调用方负责后续 saveAccounts() / saveProviderConnections() 持久化。
 */
export function syncAccountToConnection(
  conn: ProviderConnection,
  account: Account,
): void {
  // ── metadata：用 buildAccountLegacyMetadata 重建，覆盖所有字段 ──
  // 包括 credentialExtras、cpaMetadata、routing 字段（proxyUrl/modelPrefix/
  // tokenEndpoint/redirectUri/proxy/userId）、settings、quotaState 等。
  const newMeta = buildAccountLegacyMetadata(account)
  // OAuth subtitle（buildAccountLegacyMetadata 不含 subtitle，需手动补充）
  if (isOAuthAccount(account)) {
    const subtitle = syncGetOAuthAccountSubtitle(account)
    if (subtitle) {
      newMeta.subtitle = subtitle
    }
  }
  // 用新 metadata 替换旧 metadata（保留非 legacy 字段如有）
  conn.metadata = newMeta as unknown as Record<string, unknown>

  // ── credential：value / context / enabled / status / cooldownUntil ──
  const cred = conn.credentials[0]
  cred.value = syncGetAccountTokenValue(account)
  cred.enabled = account.enabled
  cred.cooldownUntil = account.cooldownUntil
  cred.status = syncMapQuotaStateToCredentialStatus(
    account.quotaState,
    account.cooldownUntil,
    account.runtimeState?.authStatus,
  )
  cred.lastError =
    account.runtimeState?.authStatus === "error" ?
      account.runtimeState.lastError
    : undefined
  cred.context = syncGetAccountContext(account)

  // ── connection 顶层字段 ──
  conn.name = account.label
  conn.enabled = account.enabled
  conn.priority = account.priority
  conn.models =
    account.availableModels ?
      account.availableModels.map((m) => syncAccountModelToMapping(m))
    : undefined
}

// ── syncAccountToConnection 辅助函数 ──────────────────────────────
// 镜像 migrate-from-accounts.ts / account-adapter.ts 中的同名函数，
// 因 connection-metadata.ts 不能导入它们（循环依赖）。

function syncReadCredentialString(
  account: Account,
  key: string,
): string | undefined {
  const value = account.credentials?.[key]
  return typeof value === "string" ? value : undefined
}

function syncGetAccountTokenValue(account: Account): string {
  if (account.provider === "copilot") {
    return account.runtimeState?.copilotToken ?? ""
  }
  if (account.provider === "codebuff") {
    return syncReadCredentialString(account, "authToken") ?? ""
  }
  if (account.provider === "windsurf") {
    return syncReadCredentialString(account, "apiKey") ?? ""
  }
  if (account.provider === "mimo-aistudio") {
    return syncReadCredentialString(account, "serviceToken") ?? ""
  }
  if (isOAuthAccount(account)) {
    return syncReadCredentialString(account, "accessToken") ?? ""
  }
  return ""
}

function syncGetAccountContext(account: Account): Record<string, unknown> {
  const base: Record<string, unknown> = { accountId: account.id }
  if (account.provider === "copilot") {
    return {
      ...base,
      githubToken: syncReadCredentialString(account, "githubToken"),
      copilotTokenExpiry: account.runtimeState?.copilotTokenExpiry,
    }
  }
  if (account.provider === "windsurf") {
    return {
      ...base,
      windsurfJwt: account.runtimeState?.windsurfJwt,
      windsurfJwtFetchedAt: account.runtimeState?.windsurfJwtFetchedAt,
    }
  }
  if (isOAuthAccount(account)) {
    return {
      ...base,
      accessToken: syncReadCredentialString(account, "accessToken"),
      refreshToken: syncReadCredentialString(account, "refreshToken"),
      expiresAt: account.credentials?.expiresAt,
      idToken: syncReadCredentialString(account, "idToken"),
      oauthAccountId: syncReadCredentialString(account, "accountId"),
      projectId: syncReadCredentialString(account, "projectId"),
      deviceId: syncReadCredentialString(account, "deviceId"),
      apiKey: syncReadCredentialString(account, "apiKey"),
    }
  }
  return base
}

function syncMapQuotaStateToCredentialStatus(
  quotaState?: "unknown" | "available" | "exhausted",
  cooldownUntil?: number,
  authStatus?: AccountRuntimeState["authStatus"],
): ApiCredential["status"] {
  if (authStatus === "error") return "auth_error"
  if (quotaState === "exhausted") return "quota_exhausted"
  if (cooldownUntil && cooldownUntil > Date.now()) return "cooldown"
  return "ready"
}

function syncAccountModelToMapping(model: AccountModel): ModelMapping {
  const endpoints: Array<ModelEndpoint> = []
  for (const ep of model.supportedEndpoints) {
    if (ep.includes("chat/completions")) endpoints.push("chat")
    else if (ep.includes("messages")) endpoints.push("messages")
    else if (ep.includes("responses")) endpoints.push("responses")
    else if (ep.includes("embeddings")) endpoints.push("embeddings")
    else if (ep.includes("images")) endpoints.push("images")
    else if (ep.includes("videos")) endpoints.push("videos")
  }
  if (endpoints.length === 0) endpoints.push("chat")

  return {
    publicId: model.id,
    upstreamId: model.upstreamId || model.id,
    name: model.name,
    vendor: model.vendor,
    endpoints,
    enabled: true,
    pickerEnabled: model.pickerEnabled,
    pickerCategory: model.pickerCategory,
  }
}

function syncGetOAuthAccountSubtitle(account: Account): string | undefined {
  if (!isOAuthAccount(account)) return undefined
  const email = account.credentials?.email?.trim()
  if (email && email !== account.label) return email
  const projectId = account.credentials?.projectId?.trim()
  if (
    account.provider === "antigravity"
    && projectId
    && projectId !== account.label
  ) {
    return projectId
  }
  const accountId = account.credentials?.accountId?.trim()
  if (accountId && accountId !== account.label) return accountId
  return undefined
}
