import type { OAuthProviderId, ProviderId } from "~/lib/provider-config"

import { isOAuthProviderId } from "~/lib/provider-config"
import {
  connectionToAccount,
  getProviderConnection,
  isAccountManagedConnection,
  listProviderConnections,
  migrateAccountsToConnections,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { parseModelReference } from "~/lib/route-target/model-reference"
import { state } from "~/lib/state"

export type AccountProvider = ProviderId
export type AccountQuotaState = "unknown" | "available" | "exhausted"

export interface AccountRuntimeState {
  copilotToken?: string
  copilotTokenExpiry?: number
  windsurfJwt?: string
  windsurfJwtFetchedAt?: number
  authStatus?: "ready" | "pending" | "error"
  lastError?: string
  lastRefreshAt?: number
  planType?: string
}

// ── Provider-specific credentials & settings types ──────────────
// 保留类型定义供 isOAuthAccount 类型守卫和 as 强转使用。
// Account 本身为扁平结构,credentials/settings 为通用 record。

export interface CopilotAccountCredentials {
  githubToken?: string
}

export interface CopilotAccountSettings {
  accountType?: string
}

export interface CodebuffAccountSettings {
  // authToken 在 credentials 中,这里保留用于 legacy 代码访问
  authToken?: string
  baseUrl?: string
  cliVersion?: string
  agentId?: string
  model?: string
  costMode?: string
  allowFallbacks?: boolean
}

export interface WindsurfAccountSettings {
  // apiKey 在 credentials 中,这里保留用于 legacy 代码访问
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
}

export interface MimoAccountCredentials {
  serviceToken?: string
  xiaomichatbotPh?: string
  mimoWsToken?: string
}

export interface MimoAccountSettings {
  userId?: string
  proxy?: string
}

export interface OAuthAccountCredentials {
  accessToken?: string
  refreshToken?: string
  idToken?: string
  expiresAt?: number
  accountId?: string
  projectId?: string
  deviceId?: string
  apiKey?: string
  email?: string
  organizationId?: string
  organizationName?: string
}

export interface OAuthAccountSettings {
  baseUrl?: string
  proxyUrl?: string
  modelPrefix?: string
  cpaSourcePath?: string
  tokenEndpoint?: string
  redirectUri?: string
  /**
   * xAI only. When true, route non-media HTTP chat to the official API
   * (api.x.ai). When false/undefined (the default), route it to the Grok CLI
   * chat-proxy. WebSocket/compact transports always use the official API
   * regardless of this flag.
   */
  useApi?: boolean
}

// ── Flat Account type ───────────────────────────────────────────
// Account 不再是联合类型,而是扁平结构。
// provider-specific 数据通过 credentials/settings 通用 record 承载。
// 使用 isOAuthAccount 类型守卫或 account.provider === "xxx" 窄化。

export interface Account {
  id: string
  label: string
  provider: AccountProvider
  credentials?: Record<string, unknown>
  settings?: Record<string, unknown>
  runtimeState?: AccountRuntimeState
  quotaState?: AccountQuotaState
  quotaInfo?: QuotaSnapshot
  quotaExhaustedAt?: number
  availableModels?: Array<AccountModel>
  enabled: boolean
  priority: number
  isExhausted?: boolean
  exhaustedAt?: number
  cooldownUntil?: number
  lastRateLimitAt?: number
  lastRateLimitReason?: string
  createdAt: number
  /** OAuth-specific metadata(cpaMetadata) */
  cpaMetadata?: Record<string, unknown>
}

export interface AccountModel {
  id: string
  name: string
  vendor: string
  pickerEnabled: boolean
  pickerCategory?: string
  supportedEndpoints: Array<string>
  provider?: AccountProvider
  upstreamId?: string
}

export interface QuotaSnapshot {
  fetchedAt: number
  premiumInteractionsRemaining?: number
  premiumInteractionsTotal?: number
  chatRemaining?: number
  chatTotal?: number
  completionsRemaining?: number
  completionsTotal?: number
  unlimited: boolean
  provider?: OAuthProviderId | "copilot"
  details?: Record<string, unknown>
}

// ── Type guards ─────────────────────────────────────────────────

/**
 * OAuth account 类型守卫。
 * 窄化后的类型可以安全访问 OAuth credentials/settings 字段。
 */
export function isOAuthAccount(account: Account): account is OAuthAccount {
  return isOAuthProviderId(account.provider)
}

// ── Provider-specific type aliases ──────────────────────────────
// 这些类型别名是 Account 的窄化视图,用于类型安全地访问 provider-specific 字段。
// Account 本身是扁平的联合 interface,这些别名不引入新的运行时分支。

export type CopilotAccount = Account & {
  provider: "copilot"
  credentials?: CopilotAccountCredentials
  settings?: CopilotAccountSettings
}

export type CodebuffAccount = Account & {
  provider: "codebuff"
  credentials?: { authToken?: string }
  settings?: CodebuffAccountSettings
}

export type WindsurfAccount = Account & {
  provider: "windsurf"
  credentials?: { apiKey?: string }
  settings?: WindsurfAccountSettings
}

export type MimoAccount = Account & {
  provider: "mimo-aistudio"
  credentials?: MimoAccountCredentials
  settings?: MimoAccountSettings
}

export type OAuthAccount = Account & {
  provider: OAuthProviderId
  credentials?: OAuthAccountCredentials
  settings?: OAuthAccountSettings
  cpaMetadata?: Record<string, unknown>
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

export function canonicalModelId(modelId: string, account?: Account): string {
  const trimmed = modelId.trim()
  const parsed = parseModelReference(trimmed, account)
  const slashIndex = trimmed.indexOf("/")
  if (account && slashIndex > 0) {
    const prefix = trimmed.slice(0, slashIndex)
    if (getAccountModelPrefix(account).toLowerCase() === prefix.toLowerCase()) {
      return `${getAccountModelPrefix(account)}/${parsed.nativeModelId}`
    }
  }
  if (parsed.provider) {
    return `${parsed.provider}/${parsed.nativeModelId}`
  }
  return parsed.nativeModelId
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
