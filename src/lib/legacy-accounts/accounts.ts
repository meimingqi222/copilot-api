import type { ProviderProtocol } from "~/lib/provider-connections/types"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections/types"

import { isOAuthProviderId, PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"
import {
  getProviderConnection,
  isAccountManagedConnection,
  listProviderConnections,
  migrateAccountsToConnections,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import {
  getConnectionAuthStatus,
  getConnectionAuthError,
  getConnectionCooldownUntil,
  getConnectionCredentialExtras,
  getConnectionCpaMetadata,
  getConnectionExhaustedAt,
  getConnectionIsExhausted,
  getConnectionLastRateLimitAt,
  getConnectionLastRateLimitReason,
  getConnectionQuotaExhaustedAt,
  getConnectionQuotaInfo,
  getConnectionQuotaState,
  getConnectionSettings,
  readAccountLegacyMetadata,
} from "~/lib/provider-connections/connection-metadata"
import { canonicalModelId as canonicalModelIdFromReference } from "~/lib/route-target/model-reference"
import { state } from "~/lib/state"

// Phase 5:类型定义已迁移到 legacy-types.ts(LegacyAccountRecord 为唯一
// 存活的 Account 形状)。此处 import + re-export 保持向后兼容:
// - LegacyAccountRecord → Account(别名,供现有代码使用)
// - 其他类型直接 re-export
import type {
  AccountModel,
  AccountProvider,
  AccountRuntimeState,
  CodebuffAccountSettings,
  LegacyAccountRecord,
  OAuthAccount,
  OAuthAccountCredentials,
  WindsurfAccountSettings,
} from "./legacy-types"
export type {
  AccountModel,
  AccountProvider,
  AccountQuotaState,
  AccountRuntimeState,
  CodebuffAccountSettings,
  CopilotAccount,
  CopilotAccountCredentials,
  CopilotAccountSettings,
  MimoAccount,
  MimoAccountCredentials,
  MimoAccountSettings,
  OAuthAccount,
  OAuthAccountCredentials,
  OAuthAccountSettings,
  QuotaSnapshot,
  WindsurfAccount,
  WindsurfAccountSettings,
} from "./legacy-types"

// Account 是 LegacyAccountRecord 的向后兼容别名。
// 外部代码使用 `Account` 类型;legacy-accounts/ 内部使用 `LegacyAccountRecord`。
export type Account = LegacyAccountRecord

// ── Type guards ─────────────────────────────────────────────────

/**
 * OAuth account 类型守卫。
 * 窄化后的类型可以安全访问 OAuth credentials/settings 字段。
 */
export function isOAuthAccount(account: Account): account is OAuthAccount {
  return isOAuthProviderId(account.provider)
}

// ── Utility functions ───────────────────────────────────────────

export function getAccountProvider(account: Account): AccountProvider {
  return account.provider
}

export function getAccountModelPrefix(account: Account): string {
  if (isOAuthAccount(account)) {
    const settings = account.settings
    const custom =
      typeof settings?.modelPrefix === "string" ?
        settings.modelPrefix.trim()
      : undefined
    if (custom) return custom
    return account.provider
  }
  return account.provider
}

export function buildAccountModelAliases(
  account: Account,
  nativeModelId: string,
): Array<string> {
  const prefix = getAccountModelPrefix(account)
  const aliases = [nativeModelId, `${prefix}/${nativeModelId}`]
  if (isOAuthAccount(account) && prefix !== account.provider) {
    aliases.push(`${account.provider}/${nativeModelId}`)
  }
  return aliases
}

/**
 * 规范化模型 ID(Phase 5:已迁移到 route-target/model-reference.ts,
 * 此处保留 Account 版本向后兼容)。
 */
export function canonicalModelId(modelId: string, account?: Account): string {
  const modelPrefix = account ? getAccountModelPrefix(account) : undefined
  return canonicalModelIdFromReference(modelId, modelPrefix)
}

// ── connectionToAccount:ProviderConnection → Account 反向映射器(内部) ──
// Phase 5:从 connection-to-account.ts 内联,不再对外导出。
// connectionToAccount 仅在 legacy-accounts/ 内部使用(listAccounts/getAccount)。
// 外部代码应使用 getAccount(conn.id) 或 listAccounts()。

/** Protocol → ProviderId 反向映射。 */
const PROTOCOL_TO_PROVIDER: Partial<Record<ProviderProtocol, string>> = {}
for (const [providerId, protocol] of Object.entries(PROVIDER_PROTOCOL_MAP)) {
  PROTOCOL_TO_PROVIDER[protocol] = providerId
}

/** ModelMapping → AccountModel 反向映射。 */
function mappingToAccountModel(input: {
  publicId: string
  upstreamId: string
  endpoints: Array<string>
  name: string | undefined
  vendor: string | undefined
  pickerEnabled: boolean | undefined
  pickerCategory: string | undefined
}): AccountModel {
  const {
    publicId,
    upstreamId,
    endpoints,
    name,
    vendor,
    pickerEnabled,
    pickerCategory,
  } = input
  const supportedEndpoints = endpoints.map((ep) => {
    switch (ep) {
      case "chat": {
        return "chat/completions"
      }
      case "messages": {
        return "messages"
      }
      case "responses": {
        return "responses"
      }
      case "embeddings": {
        return "embeddings"
      }
      case "images": {
        return "images"
      }
      case "videos": {
        return "videos"
      }
      default: {
        return ep
      }
    }
  })
  if (supportedEndpoints.length === 0)
    supportedEndpoints.push("chat/completions")
  return {
    id: publicId,
    name: name ?? publicId,
    vendor: vendor ?? "",
    pickerEnabled: pickerEnabled ?? true,
    pickerCategory,
    supportedEndpoints,
    upstreamId: upstreamId === publicId ? undefined : upstreamId,
  }
}

/**
 * 从 connection.models 反构造 availableModels(保留三态语义)。
 * - undefined/null → undefined(尚未加载,触发通配 target)
 * - [] → [](跳过,不生成通配 target)
 * - 非空 → 映射后的 AccountModel[]
 *
 * Phase 5:导出供 account-views.ts 在 legacy 边界内使用,
 * 避免外部代码调用 connectionToAccount 派生完整 Account 快照。
 */
export function connectionModelsToAccountModels(
  conn: ProviderConnection,
): Array<AccountModel> | undefined {
  const models = conn.models as Array<ModelMapping> | null | undefined
  if (models === undefined || models === null) return undefined
  if (models.length === 0) return []
  return models.map((m) =>
    mappingToAccountModel({
      publicId: m.publicId,
      upstreamId: m.upstreamId,
      endpoints: m.endpoints,
      name: m.name,
      vendor: m.vendor,
      pickerEnabled: m.pickerEnabled,
      pickerCategory: m.pickerCategory,
    }),
  )
}

/** 从 credential.context 反构造 runtimeState(最小子集)。 */
function buildRuntimeState(
  conn: ProviderConnection,
): AccountRuntimeState | undefined {
  const cred = conn.credentials[0]
  const ctx = cred.context
  if (!ctx) {
    const authStatus = getConnectionAuthStatus(conn)
    const authError = getConnectionAuthError(conn)
    if (authStatus === "ready" && !authError) return undefined
    return {
      authStatus:
        authStatus === "ready" ? undefined : (
          (authStatus as AccountRuntimeState["authStatus"])
        ),
      lastError: authError ?? undefined,
    }
  }
  const runtime: AccountRuntimeState = {}
  const authStatus = getConnectionAuthStatus(conn)
  const authError = getConnectionAuthError(conn)
  if (authStatus !== "ready") {
    runtime.authStatus = authStatus as AccountRuntimeState["authStatus"]
  }
  if (authError) {
    runtime.lastError = authError
  }
  if (typeof ctx.copilotTokenExpiry === "number") {
    runtime.copilotTokenExpiry = ctx.copilotTokenExpiry
  }
  if (cred.refresherType === "copilot-token" && cred.value) {
    runtime.copilotToken = cred.value
  }
  if (typeof ctx.windsurfJwt === "string") {
    runtime.windsurfJwt = ctx.windsurfJwt
  }
  if (typeof ctx.windsurfJwtFetchedAt === "number") {
    runtime.windsurfJwtFetchedAt = ctx.windsurfJwtFetchedAt
  }
  if (Object.keys(runtime).length === 0) return undefined
  return runtime
}

/** 从 credential + credentialExtras + context 反构造 credentials record。 */
function buildCredentials(
  conn: ProviderConnection,
  provider: string,
): Record<string, unknown> | undefined {
  const cred = conn.credentials[0]
  const credentials: Record<string, unknown> = {}
  const ctx = cred.context
  if (cred.value) {
    switch (provider) {
      case "copilot": {
        break
      }
      case "codebuff": {
        credentials.authToken = cred.value
        break
      }
      case "windsurf": {
        credentials.apiKey = cred.value
        break
      }
      case "mimo-aistudio": {
        credentials.serviceToken = cred.value
        break
      }
      default: {
        if (isOAuthProviderId(provider)) {
          credentials.accessToken = cred.value
        }
      }
    }
  }
  if (ctx) {
    if (provider === "copilot" && typeof ctx.githubToken === "string") {
      credentials.githubToken = ctx.githubToken
    }
    if (isOAuthProviderId(provider)) {
      if (typeof ctx.refreshToken === "string")
        credentials.refreshToken = ctx.refreshToken
      if (typeof ctx.idToken === "string") credentials.idToken = ctx.idToken
      if (typeof ctx.expiresAt === "number")
        credentials.expiresAt = ctx.expiresAt
      if (typeof ctx.oauthAccountId === "string")
        credentials.accountId = ctx.oauthAccountId
      if (typeof ctx.projectId === "string")
        credentials.projectId = ctx.projectId
      if (typeof ctx.deviceId === "string") credentials.deviceId = ctx.deviceId
      if (typeof ctx.apiKey === "string") credentials.apiKey = ctx.apiKey
    }
  }
  const extras = getConnectionCredentialExtras(conn)
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (value !== undefined) credentials[key] = value
    }
  }
  if (Object.keys(credentials).length === 0) return undefined
  return credentials
}

/** 从 metadata 反构造 settings record。 */
function buildSettings(
  conn: ProviderConnection,
): Record<string, unknown> | undefined {
  const settings = getConnectionSettings(conn)
  if (!settings) return undefined
  if (Object.keys(settings).length === 0) return undefined
  return { ...settings }
}

/**
 * 将 ProviderConnection 反构造为 Account。
 * runtimeState 仅恢复最小子集(authStatus/lastError + context 中的时间戳)。
 *
 * Phase 5:从 connection-to-account.ts 内联。仅供 legacy-accounts/ 内部
 * 及测试使用(listAccounts/getAccount 内部调用,测试用于 round-trip 验证)。
 * src/ 中 legacy-accounts/ 之外的代码应使用 getAccount(conn.id) 或 listAccounts()。
 */
export function connectionToAccount(connection: ProviderConnection): Account {
  const meta = readAccountLegacyMetadata(connection)
  const provider =
    meta?.provider ?? PROTOCOL_TO_PROVIDER[connection.protocol] ?? "copilot"
  const cred = connection.credentials[0]
  const account: Account = {
    id: connection.id,
    label: connection.name,
    provider: provider as Account["provider"],
    enabled: connection.enabled,
    priority: connection.priority,
    createdAt: connection.createdAt,
    quotaState: getConnectionQuotaState(connection),
    quotaInfo: getConnectionQuotaInfo(connection),
    quotaExhaustedAt: getConnectionQuotaExhaustedAt(connection),
    exhaustedAt: getConnectionExhaustedAt(connection),
    isExhausted: getConnectionIsExhausted(connection),
    cooldownUntil: getConnectionCooldownUntil(connection),
    lastRateLimitAt: getConnectionLastRateLimitAt(connection),
    lastRateLimitReason: getConnectionLastRateLimitReason(connection),
    availableModels: connectionModelsToAccountModels(connection),
    credentials: buildCredentials(connection, provider),
    settings: buildSettings(connection),
    runtimeState: buildRuntimeState(connection),
  }
  const cpaMetadata = getConnectionCpaMetadata(connection)
  if (cpaMetadata !== undefined) {
    account.cpaMetadata = cpaMetadata
  }
  if (cred.enabled !== connection.enabled) {
    account.enabled = cred.enabled
  }
  return account
}

/**
 * 列出所有 account-derived connections 反构造为 Account。
 * 替代 state.accounts 读取。
 */
export function listAccounts(): Array<Account> {
  return listProviderConnections()
    .filter((c) => isAccountManagedConnection(c))
    .map((c) => connectionToAccount(c))
}

/**
 * 按 id 查找 Account（从 connection 反构造）。
 * 替代 state.accounts.find(a => a.id === id)。
 * 返回的是快照副本，修改不会反映到 connection。
 */
export function getAccount(id: string): Account | undefined {
  const conn = getProviderConnection(id)
  if (!conn || !isAccountManagedConnection(conn)) return undefined
  return connectionToAccount(conn)
}

export function addAccount(account: Account): void {
  const conn = migrateAccountsToConnections([account])[0]
  upsertProviderConnection(conn)
}

// ── Provider-specific getter/setter compatibility layer ─────────
// 这些函数是扁平 Account interface 之上的薄封装,提供向后兼容的访问接口。
// 它们不引入新的运行时分支,只是类型安全的字段访问器。

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function writeCredentialField(
  account: Account,
  key: string,
  value: string | undefined,
): void {
  const current = account.credentials ?? {}
  account.credentials =
    value === undefined ?
      Object.fromEntries(Object.entries(current).filter(([k]) => k !== key))
    : { ...current, [key]: value }
}

function writeSettingsField(
  account: Account,
  key: string,
  value: string | undefined,
): void {
  const current = account.settings ?? {}
  account.settings =
    value === undefined ?
      Object.fromEntries(Object.entries(current).filter(([k]) => k !== key))
    : { ...current, [key]: value }
}

// Copilot
export function getGitHubToken(account: Account): string | undefined {
  return readString(account.credentials?.githubToken)
}

export function setGitHubToken(
  account: Account,
  value: string | undefined,
): void {
  writeCredentialField(account, "githubToken", value)
}

export function getCopilotToken(account: Account): string | undefined {
  return account.runtimeState?.copilotToken
}

export function setCopilotToken(
  account: Account,
  value: string | undefined,
): void {
  account.runtimeState = {
    ...account.runtimeState,
    copilotToken: value,
  }
}

export function setCopilotTokenExpiry(
  account: Account,
  value: number | undefined,
): void {
  account.runtimeState = {
    ...account.runtimeState,
    copilotTokenExpiry: value,
  }
}

// Codebuff
export function getCodebuffAuthToken(account: Account): string | undefined {
  return readString(account.credentials?.authToken)
}

export function setCodebuffAuthToken(
  account: Account,
  value: string | undefined,
): void {
  writeCredentialField(account, "authToken", value)
}

export function getCodebuffSettings(
  account: Account,
): CodebuffAccountSettings | undefined {
  if (account.provider !== "codebuff") return undefined
  // 合并 credentials.authToken 到 settings 视图(legacy 访问路径)
  return {
    ...(account.settings as CodebuffAccountSettings | undefined),
    authToken: readString(account.credentials?.authToken),
  }
}

// Windsurf
export function getWindsurfApiKey(account: Account): string | undefined {
  return readString(account.credentials?.apiKey)
}

export function setWindsurfApiKey(
  account: Account,
  value: string | undefined,
): void {
  writeCredentialField(account, "apiKey", value)
}

export function getWindsurfSettings(
  account: Account,
): WindsurfAccountSettings | undefined {
  if (account.provider !== "windsurf") return undefined
  const defaults = state.providerDefaults.windsurf
  const settings = account.settings as WindsurfAccountSettings | undefined
  // 逐字段用 providerDefaults 兜底 — 不能用对象展开,否则 account.settings 里
  // 显式 undefined 的字段会覆盖 defaults(admin UI 导入的账号常出现此情况)。
  return {
    apiKey: readString(account.credentials?.apiKey) ?? defaults.apiKey,
    baseUrl: settings?.baseUrl ?? defaults.baseUrl,
    defaultModel: settings?.defaultModel ?? defaults.defaultModel,
  }
}

// Mimo
export function getMimoServiceToken(account: Account): string | undefined {
  return readString(account.credentials?.serviceToken)
}

export function setMimoServiceToken(
  account: Account,
  value: string | undefined,
): void {
  writeCredentialField(account, "serviceToken", value)
}

export function getMimoPh(account: Account): string | undefined {
  return readString(account.credentials?.xiaomichatbotPh)
}

export function setMimoPh(account: Account, value: string | undefined): void {
  writeCredentialField(account, "xiaomichatbotPh", value)
}

export function getMimoWsToken(account: Account): string | undefined {
  return readString(account.credentials?.mimoWsToken)
}

export function setMimoWsToken(
  account: Account,
  value: string | undefined,
): void {
  writeCredentialField(account, "mimoWsToken", value)
}

export function getMimoUserId(account: Account): string | undefined {
  return readString(account.settings?.userId)
}

export function setMimoUserId(
  account: Account,
  value: string | undefined,
): void {
  writeSettingsField(account, "userId", value)
}

export function getMimoProxy(account: Account): string | undefined {
  return readString(account.settings?.proxy)
}

export function setMimoProxy(
  account: Account,
  value: string | undefined,
): void {
  writeSettingsField(account, "proxy", value)
}

// OAuth
export function getOAuthAccessToken(account: Account): string | undefined {
  return isOAuthAccount(account) ?
      readString(account.credentials?.accessToken)
    : undefined
}

export function getOAuthRefreshToken(account: Account): string | undefined {
  return isOAuthAccount(account) ?
      readString(account.credentials?.refreshToken)
    : undefined
}

export function getOAuthApiKey(account: Account): string | undefined {
  return isOAuthAccount(account) ?
      readString(account.credentials?.apiKey)
    : undefined
}

export function getOAuthAccountId(account: Account): string | undefined {
  return isOAuthAccount(account) ?
      readString(account.credentials?.accountId)
    : undefined
}

export function getOAuthProjectId(account: Account): string | undefined {
  return isOAuthAccount(account) ?
      readString(account.credentials?.projectId)
    : undefined
}

export function getOAuthDeviceId(account: Account): string | undefined {
  return isOAuthAccount(account) ?
      readString(account.credentials?.deviceId)
    : undefined
}

export function getOAuthProxyUrl(account: Account): string | undefined {
  return isOAuthAccount(account) ?
      readString(account.settings?.proxyUrl)
    : undefined
}

export function setOAuthCredentials(
  account: Account,
  patch: Partial<OAuthAccountCredentials>,
): void {
  if (!isOAuthAccount(account)) return
  let credentials: Record<string, unknown> = { ...account.credentials }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    credentials =
      value === undefined ?
        Object.fromEntries(
          Object.entries(credentials).filter(([k]) => k !== key),
        )
      : { ...credentials, [key]: value }
  }
  account.credentials = credentials
}

export {
  canonicalNativeModelId,
  parseModelReference,
} from "~/lib/route-target/model-reference"
