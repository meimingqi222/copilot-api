/**
 * Provider Connection 类型定义
 *
 * Provider Connection 表示一个上游服务实例(如 DeepSeek、OpenRouter、企业 vLLM),
 * Protocol 决定调用方式。同一 protocol 可被多个 connection 复用,新增 OpenAI/Anthropic
 * 兼容的服务商无需新增 TypeScript runtime 文件。
 */

import type { CredentialRefresherType } from "./credential-refresher"

export type ProviderProtocol =
  | "openai-compatible"
  | "openai-responses-compatible"
  | "anthropic-compatible"
  | "copilot-native"
  | "windsurf-native"
  | "codebuff-native"
  | "mimo-native"
  | "codex-native"
  | "claude-native"
  | "antigravity-native"
  | "kimi-native"
  | "xai-native"

export const PROVIDER_PROTOCOLS: ReadonlyArray<ProviderProtocol> = [
  "openai-compatible",
  "openai-responses-compatible",
  "anthropic-compatible",
  "copilot-native",
  "windsurf-native",
  "codebuff-native",
  "mimo-native",
  "codex-native",
  "claude-native",
  "antigravity-native",
  "kimi-native",
  "xai-native",
]

export function isProviderProtocol(value: string): value is ProviderProtocol {
  return PROVIDER_PROTOCOLS.includes(value as ProviderProtocol)
}

export type ModelEndpoint =
  | "chat"
  | "responses"
  | "messages"
  | "embeddings"
  | "images"
  | "videos"

export const MODEL_ENDPOINTS: ReadonlyArray<ModelEndpoint> = [
  "chat",
  "responses",
  "messages",
  "embeddings",
  "images",
  "videos",
]

export function isModelEndpoint(value: string): value is ModelEndpoint {
  return MODEL_ENDPOINTS.includes(value as ModelEndpoint)
}

/**
 * 根据 protocol 返回默认的 model endpoints。
 *
 * 当用户通过 admin API 添加模型但未显式指定 endpoints 时使用此函数,
 * 确保默认 endpoint 与 protocol adapter 实际支持的能力匹配。
 *
 * - `anthropic-compatible` / `claude-native`: adapter 只实现 createMessages → `["messages"]`
 * - 其他所有 protocol: adapter 至少实现 createChatCompletions → `["chat"]`
 */
export function defaultEndpointsForProtocol(
  protocol: ProviderProtocol,
): Array<ModelEndpoint> {
  if (protocol === "anthropic-compatible" || protocol === "claude-native") {
    return ["messages"]
  }
  return ["chat"]
}

/**
 * 凭据鉴权模式。
 *
 * - `bearer`: `Authorization: Bearer <value>`(默认)。
 * - `header`: 自定义 header,需配合 `headerName`(如 `X-API-Key`)。
 *
 * 备注:原始方案区分 `api-key-header` 与 `custom-header`,实现上两者本质相同,
 * 收敛为单一 `header` 模式以简化分支。
 */
export type CredentialAuthMode = "bearer" | "header"

export const CREDENTIAL_AUTH_MODES: ReadonlyArray<CredentialAuthMode> = [
  "bearer",
  "header",
]

export function isCredentialAuthMode(
  value: string,
): value is CredentialAuthMode {
  return CREDENTIAL_AUTH_MODES.includes(value as CredentialAuthMode)
}

/**
 * 凭据可用性状态机:
 * - `ready`: 可调度。
 * - `cooldown`: 临时冷却(429 / 上游 retry-after / 5xx 短退避),到期自动恢复。
 * - `auth_error`: 401/403 等鉴权错误,需手动激活。
 * - `quota_exhausted`: 明确余额/配额耗尽。默认配置长冷却(24h)后自动恢复,
 *   也可通过 admin API 手动 reset。
 * - `disabled`: 用户手动禁用。
 */
export type CredentialStatus =
  | "ready"
  | "cooldown"
  | "auth_error"
  | "quota_exhausted"
  | "disabled"

export const CREDENTIAL_STATUSES: ReadonlyArray<CredentialStatus> = [
  "ready",
  "cooldown",
  "auth_error",
  "quota_exhausted",
  "disabled",
]

export interface ApiCredential {
  id: string
  label?: string
  authMode: CredentialAuthMode
  /** 当 authMode === "header" 时使用的 header 名,默认 "Authorization"。 */
  headerName?: string
  /** 凭据原始值(secret)。导出 API 必须脱敏。 */
  value: string
  enabled: boolean
  priority?: number
  weight?: number
  status: CredentialStatus
  cooldownUntil?: number
  lastRateLimitAt?: number
  lastErrorAt?: number
  lastError?: string
  createdAt: number
  updatedAt?: number
  /** 凭据刷新器类型。用于动态 token 刷新(Copilot/OAuth)。 */
  refresherType?: CredentialRefresherType
  /** 刷新所需的源材料(githubToken / refreshToken 等)。不对外暴露。 */
  context?: Record<string, unknown>
}

export interface ModelMapping {
  /** 对客户端暴露的模型名,例如 `deepseek-v4-flash`。 */
  publicId: string
  /** 请求上游时实际使用的模型名。 */
  upstreamId: string
  /** 客户端可用的别名(也对外暴露)。 */
  aliases?: Array<string>
  name?: string
  vendor?: string
  endpoints: Array<ModelEndpoint>
  enabled: boolean
  pickerEnabled?: boolean
  pickerCategory?: string
  metadata?: Record<string, unknown>
}

export type ModelDiscoveryMode = "merge" | "replace" | "manual-only"

export interface ModelDiscoveryConfig {
  enabled: boolean
  /**
   * 自定义模型列表端点(相对 baseUrl 或绝对 URL)。
   * 默认 `${baseUrl}/models`。
   */
  endpoint?: string
  intervalMs?: number
  mode?: ModelDiscoveryMode
  include?: Array<string>
  exclude?: Array<string>
}

export interface ProviderConnection {
  id: string
  name: string
  protocol: ProviderProtocol
  /**
   * 上游 API 根地址。
   * 可写带版本前缀(如 `https://api.deepseek.com/v1`)，也可写到服务根
   * (如 `https://ark.cn-beijing.volces.com/api/coding`)：
   * 对 `/messages`、`/chat/completions` 等标准路径，adapter 会在缺少
   * `/v1` 时自动补上。
   */
  baseUrl: string
  enabled: boolean
  priority: number
  weight?: number
  /** Provider 级固定 header(不应包含 secret)。 */
  headers?: Record<string, string>
  modelDiscovery?: ModelDiscoveryConfig
  /** 手工声明、覆盖或补充模型;与自动发现结果按 mode 合并。 */
  models?: Array<ModelMapping>
  credentials: Array<ApiCredential>
  /** 上次自动模型发现时间。 */
  lastModelDiscoveryAt?: number
  /** 上次自动模型发现错误。 */
  lastModelDiscoveryError?: string
  createdAt: number
  updatedAt?: number
  /** 扩展元数据。用于 account→connection 适配时承载 provider-specific 字段(cpaMetadata, proxyUrl 等)。 */
  metadata?: Record<string, unknown>
}

/**
 * 调度单位:把 (connection, credential, model, endpoint) 展平为可路由的目标。
 * 选择器从所有候选 RouteTarget 中按优先级/权重挑选。
 *
 * 批次 3：account 字段已删除。protocol adapter 通过 connectionToAccount(connection)
 * 从 connection 派生 Account。
 */
export interface RouteTarget {
  connectionId: string
  connectionName: string
  protocol: ProviderProtocol
  credentialId: string
  publicModelId: string
  upstreamModelId: string
  endpoint: ModelEndpoint
  connectionPriority: number
  connectionWeight: number
  credentialPriority: number
  credentialWeight: number
  /**
   * 通配 target 标志:由 availableModels === undefined 的 account 生成,
   * 可匹配任意请求模型但优先级最低(仅作兜底)。
   * session affinity 不应粘住通配 target —— 当专用 connection 可用时应
   * 优先走专用,避免通配 account 抢占本该路由到专用 provider 的请求。
   */
  isWildcard?: boolean
}

/**
 * 默认值常量。集中放置便于跨模块复用。
 */
export const DEFAULTS = {
  CONNECTION_PRIORITY: 10,
  CONNECTION_WEIGHT: 1,
  CREDENTIAL_PRIORITY: 0,
  CREDENTIAL_WEIGHT: 1,
  COOLDOWN_5XX_MS: 30_000,
  COOLDOWN_NETWORK_MS: 15_000,
  COOLDOWN_429_FALLBACK_MS: 60_000,
  QUOTA_EXHAUSTED_AUTO_RECOVERY_MS: 24 * 60 * 60 * 1000,
  MODEL_DISCOVERY_INTERVAL_MS: 60 * 60 * 1000,
} as const
