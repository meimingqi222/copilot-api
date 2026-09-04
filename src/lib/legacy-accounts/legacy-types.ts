/**
 * Legacy Account 类型定义 (Phase 5)。
 *
 * 这是唯一存活的 Account 形状,改名 LegacyAccountRecord。
 * accounts.json 文件格式的类型边界 — 仅在 legacy-accounts/ 内部使用。
 * 外部代码应使用 ProviderConnection 代替。
 *
 * accounts.ts 通过 `import type { LegacyAccountRecord } from "./legacy-types"`
 * 引入并 re-export 为 `Account` 别名,保持向后兼容。
 */
import type { OAuthProviderId, ProviderId } from "~/lib/provider-config"
import type { QuotaSnapshot } from "~/lib/quota/types"

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
// LegacyAccountRecord 本身为扁平结构,credentials/settings 为通用 record。

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

// ── Flat Account type (renamed to LegacyAccountRecord) ──────────
// 不再是联合类型,而是扁平结构。
// provider-specific 数据通过 credentials/settings 通用 record 承载。
// 使用 isOAuthAccount 类型守卫或 account.provider === "xxx" 窄化。

export interface LegacyAccountRecord {
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

// Phase 5:QuotaSnapshot 已迁移到 lib/quota/types.ts,
// 此处 re-export 保持向后兼容。
export type { QuotaSnapshot } from "~/lib/quota/types"

// ── Provider-specific type aliases ──────────────────────────────
// 这些类型别名是 LegacyAccountRecord 的窄化视图,用于类型安全地访问
// provider-specific 字段。LegacyAccountRecord 本身是扁平 interface,
// 这些别名不引入新的运行时分支。

export type CopilotAccount = LegacyAccountRecord & {
  provider: "copilot"
  credentials?: CopilotAccountCredentials
  settings?: CopilotAccountSettings
}

export type CodebuffAccount = LegacyAccountRecord & {
  provider: "codebuff"
  credentials?: { authToken?: string }
  settings?: CodebuffAccountSettings
}

export type WindsurfAccount = LegacyAccountRecord & {
  provider: "windsurf"
  credentials?: { apiKey?: string }
  settings?: WindsurfAccountSettings
}

export type MimoAccount = LegacyAccountRecord & {
  provider: "mimo-aistudio"
  credentials?: MimoAccountCredentials
  settings?: MimoAccountSettings
}

export type OAuthAccount = LegacyAccountRecord & {
  provider: OAuthProviderId
  credentials?: OAuthAccountCredentials
  settings?: OAuthAccountSettings
  cpaMetadata?: Record<string, unknown>
}
