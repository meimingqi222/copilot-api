/**
 * Account-managed connection 的创建、视图与导出。
 *
 * 取代原 legacy Account 兼容层(accounts.json / legacy-accounts/):
 * - `ManagedConnectionInput` —— /admin/api/accounts 创建、批量导入与测试
 *   构造 account-managed connection 的输入形状。
 * - `managedConnectionFromInput` —— 输入 → ProviderConnection。provider →
 *   (credential.value, credential.context, credentialExtras, refresherType)
 *   的知识集中在这一处。
 * - `AccountModel` / `connectionModelsToAccountModels` —— admin API
 *   `availableModels` 条目形状(HTTP 契约冻结)及其从 connection.models 的派生。
 * - `serializeConnectionForExport` —— `/admin/api/accounts/export` 的 JSON 形状,
 *   与导入路径(`ImportAccountPayload`)互为往返。
 */
import {
  isOAuthProviderId,
  PROVIDER_PROTOCOL_MAP,
  type ProviderId,
} from "~/lib/provider-config"
import type { QuotaSnapshot } from "~/lib/quota/types"

import type { CredentialRefresherType } from "./credential-refresher"
import {
  getConnectionCooldownUntil,
  getConnectionCpaMetadata,
  getConnectionCredentialExtras,
  getConnectionProvider,
  getConnectionQuotaExhaustedAt,
  getConnectionQuotaInfo,
  getConnectionQuotaState,
  getConnectionSettings,
  getPrimaryTokenKey,
} from "./connection-metadata"
import type {
  ApiCredential,
  ModelEndpoint,
  ModelMapping,
  ProviderConnection,
} from "./types"

/**
 * admin `/admin/api/accounts` 响应的 `availableModels` 条目形状。
 *
 * 形如 `/v1/messages` 的 endpoint 路径字符串(非 ModelEndpoint 枚举)——
 * admin UI 依赖此形状,不要改成 ModelMapping。
 */
export interface AccountModel {
  id: string
  name: string
  vendor: string
  pickerEnabled: boolean
  pickerCategory?: string
  supportedEndpoints: Array<string>
  provider?: ProviderId
  upstreamId?: string
}

/** 创建 account-managed connection 时的运行态最小子集。 */
export interface ManagedConnectionRuntimeState {
  copilotToken?: string
  copilotTokenExpiry?: number
  windsurfJwt?: string
  windsurfJwtFetchedAt?: number
  authStatus?: "ready" | "pending" | "error"
  lastError?: string
  lastRefreshAt?: number
  planType?: string
}

/**
 * 创建 account-managed connection 的输入。
 *
 * credentials 为 provider-specific 扁平 record(copilot 用 githubToken、
 * codebuff 用 authToken、OAuth 用 accessToken/refreshToken…),
 * 由 `managedConnectionFromInput` 按 provider 映射到 credential.value /
 * credential.context / metadata.credentialExtras。
 */
export interface ManagedConnectionInput {
  id: string
  name: string
  provider: ProviderId
  credentials?: Record<string, unknown>
  settings?: Record<string, unknown>
  runtimeState?: ManagedConnectionRuntimeState
  quotaState?: "unknown" | "available" | "exhausted"
  quotaInfo?: QuotaSnapshot
  quotaExhaustedAt?: number
  availableModels?: Array<AccountModel>
  enabled?: boolean
  priority?: number
  isExhausted?: boolean
  exhaustedAt?: number
  cooldownUntil?: number
  lastRateLimitAt?: number
  lastRateLimitReason?: string
  createdAt?: number
  cpaMetadata?: Record<string, unknown>
}

// ── 输入 → ProviderConnection ────────────────────────────────────

function readString(
  credentials: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = credentials?.[key]
  return typeof value === "string" ? value : undefined
}

/** credential.value:provider 的当前生效 token。 */
function tokenValueOf(input: ManagedConnectionInput): string {
  const provider = input.provider
  const credentials = input.credentials
  if (provider === "copilot") {
    // copilot 的 credential.value 是刷新得到的 JWT,不由创建输入提供。
    return input.runtimeState?.copilotToken ?? ""
  }
  if (provider === "codebuff") return readString(credentials, "authToken") ?? ""
  if (provider === "windsurf") return readString(credentials, "apiKey") ?? ""
  if (provider === "mimo-aistudio") {
    return readString(credentials, "serviceToken") ?? ""
  }
  if (provider === "codebuddy" || provider === "codebuddy-cn") {
    return readString(credentials, "accessToken") ?? ""
  }
  if (provider === "lobsterai") {
    return readString(credentials, "accessToken") ?? ""
  }
  if (isOAuthProviderId(provider)) {
    return readString(credentials, "accessToken") ?? ""
  }
  return ""
}

/** credential.context:刷新所需的源材料。 */
function tokenContextOf(
  input: ManagedConnectionInput,
): Record<string, unknown> {
  const provider = input.provider
  const credentials = input.credentials
  const base: Record<string, unknown> = { accountId: input.id }
  if (provider === "copilot") {
    return {
      ...base,
      githubToken: readString(credentials, "githubToken"),
      copilotTokenExpiry: input.runtimeState?.copilotTokenExpiry,
    }
  }
  if (provider === "windsurf") {
    return {
      ...base,
      windsurfJwt: input.runtimeState?.windsurfJwt,
      windsurfJwtFetchedAt: input.runtimeState?.windsurfJwtFetchedAt,
    }
  }
  if (provider === "codebuddy" || provider === "codebuddy-cn") {
    return {
      ...base,
      refreshToken: readString(credentials, "refreshToken"),
      expiresAt: credentials?.expiresAt,
    }
  }
  if (provider === "lobsterai") {
    return {
      ...base,
      refreshToken: readString(credentials, "refreshToken"),
      expiresAt: credentials?.expiresAt,
      // keyfrom 归因字段:refresh 时回传,缺失时服务端默认 official。
      uuid: readString(credentials, "uuid"),
      userId: readString(credentials, "userId"),
      firstKeyfrom: readString(credentials, "firstKeyfrom"),
      latestKeyfrom: readString(credentials, "latestKeyfrom"),
    }
  }
  if (isOAuthProviderId(provider)) {
    return {
      ...base,
      accessToken: readString(credentials, "accessToken"),
      refreshToken: readString(credentials, "refreshToken"),
      expiresAt: credentials?.expiresAt,
      idToken: readString(credentials, "idToken"),
      oauthAccountId: readString(credentials, "accountId"),
      projectId: readString(credentials, "projectId"),
      deviceId: readString(credentials, "deviceId"),
      apiKey: readString(credentials, "apiKey"),
      // email 同时落入 context(供 connection 原生 label/subtitle 推断读取)
      // 与 credentialExtras(导出/导入往返)。
      email: readString(credentials, "email"),
    }
  }
  return base
}

function refresherTypeOf(provider: ProviderId): CredentialRefresherType {
  if (provider === "copilot") return "copilot-token"
  if (isOAuthProviderId(provider)) return "oauth-token"
  if (provider === "windsurf") return "windsurf-jwt"
  if (provider === "codebuddy" || provider === "codebuddy-cn") {
    return "codebuddy-token"
  }
  if (provider === "lobsterai") return "lobsterai-token"
  return "static"
}

/** AccountModel → ModelMapping。 */
function accountModelToMapping(model: AccountModel): ModelMapping {
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

/**
 * 创建 account-managed connection。
 *
 * 保持 id 不变(绝不生成新 id,否则 stats-store 历史断链)。
 * runtimeState 不持久化到 connection.metadata 之外。
 */
export function managedConnectionFromInput(
  input: ManagedConnectionInput,
): ProviderConnection {
  const provider = input.provider
  const protocol = PROVIDER_PROTOCOL_MAP[provider]
  const createdAt = input.createdAt ?? Date.now()
  const enabled = input.enabled ?? true

  const credentialStatus: ApiCredential["status"] =
    input.runtimeState?.authStatus === "error" ? "auth_error"
    : input.quotaState === "exhausted" ? "quota_exhausted"
    : input.cooldownUntil && input.cooldownUntil > Date.now() ? "cooldown"
    : enabled ? "ready"
    : "disabled"

  const credential: ApiCredential = {
    id: input.id,
    authMode: "bearer",
    value: tokenValueOf(input),
    enabled,
    status: credentialStatus,
    cooldownUntil: input.cooldownUntil,
    lastError:
      input.runtimeState?.authStatus === "error" ?
        input.runtimeState.lastError
      : undefined,
    createdAt,
    refresherType: refresherTypeOf(provider),
    context: tokenContextOf(input),
  }

  // credentialExtras:非 primary token 的 credentials 字段。
  // (OAuth 的 refreshToken/idToken/expiresAt/accountId/projectId/deviceId/
  // apiKey/email、mimo 的 xiaomichatbotPh/mimoWsToken 等)
  const primaryTokenKey = getPrimaryTokenKey(provider)
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.credentials ?? {})) {
    if (key === primaryTokenKey) continue
    if (value !== undefined) extras[key] = value
  }

  const settings = input.settings ?? {}
  const metadata: Record<string, unknown> = {
    provider,
    authStatus: input.runtimeState?.authStatus ?? "ready",
    authError: input.runtimeState?.lastError ?? null,
    quotaState: input.quotaState ?? "unknown",
    settings,
  }
  if (input.isExhausted !== undefined) metadata.isExhausted = input.isExhausted
  if (input.exhaustedAt !== undefined) metadata.exhaustedAt = input.exhaustedAt
  if (input.quotaExhaustedAt !== undefined) {
    metadata.quotaExhaustedAt = input.quotaExhaustedAt
  }
  if (input.quotaInfo) {
    // 同时写入 credential.quota(类型化字段)与 metadata.quotaInfo(兼容读路径)
    metadata.quotaInfo = input.quotaInfo
    credential.quota = input.quotaInfo
  }
  if (input.lastRateLimitAt !== undefined) {
    metadata.lastRateLimitAt = input.lastRateLimitAt
  }
  if (input.lastRateLimitReason !== undefined) {
    metadata.lastRateLimitReason = input.lastRateLimitReason
  }
  if (Object.keys(extras).length > 0) metadata.credentialExtras = extras
  if (input.cpaMetadata) metadata.cpaMetadata = input.cpaMetadata
  // OAuth routing 字段从 settings 提取到 metadata 顶层
  if (typeof settings.proxyUrl === "string")
    metadata.proxyUrl = settings.proxyUrl
  if (typeof settings.modelPrefix === "string") {
    metadata.modelPrefix = settings.modelPrefix
  }
  if (typeof settings.tokenEndpoint === "string") {
    metadata.tokenEndpoint = settings.tokenEndpoint
  }
  if (typeof settings.redirectUri === "string") {
    metadata.redirectUri = settings.redirectUri
  }
  // mimo-specific
  if (typeof settings.proxy === "string") metadata.proxy = settings.proxy
  if (typeof settings.userId === "string") metadata.userId = settings.userId

  // CodeBuddy 国内版/国际版默认 baseUrl + X-Domain header。
  // codebuddy-native adapter 从 connection.baseUrl / connection.headers 读取,
  // account-managed 路径需在此设置默认值(其他 account-managed 协议的
  // baseUrl 由 metadata.settings.baseUrl 承载,保持 "")。
  let baseUrl = ""
  let headers: Record<string, string> | undefined
  if (provider === "codebuddy") {
    baseUrl = "https://www.workbuddy.ai/v2"
    headers = { "X-Domain": "www.workbuddy.ai" }
  } else if (provider === "codebuddy-cn") {
    baseUrl = "https://copilot.tencent.com/v2"
    headers = { "X-Domain": "www.codebuddy.cn" }
  }

  return {
    id: input.id,
    name: input.name,
    protocol,
    baseUrl,
    ...(headers ? { headers } : {}),
    enabled,
    priority: input.priority ?? 0,
    credentials: [credential],
    models: input.availableModels?.map((m) => accountModelToMapping(m)),
    createdAt,
    metadata,
  }
}

// ── ProviderConnection → AccountModel[] ─────────────────────────

function mappingToAccountModel(mapping: ModelMapping): AccountModel {
  const supportedEndpoints = mapping.endpoints.map((ep) => {
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
    id: mapping.publicId,
    name: mapping.name ?? mapping.publicId,
    vendor: mapping.vendor ?? "",
    pickerEnabled: mapping.pickerEnabled ?? true,
    pickerCategory: mapping.pickerCategory,
    supportedEndpoints,
    upstreamId:
      mapping.upstreamId === mapping.publicId ? undefined : mapping.upstreamId,
  }
}

/**
 * 从 connection.models 反构造 availableModels(保留三态语义)。
 * - undefined/null → undefined(尚未加载,触发通配 target)
 * - [] → [](跳过,不生成通配 target)
 * - 非空 → 映射后的 AccountModel[]
 */
export function connectionModelsToAccountModels(
  conn: ProviderConnection,
): Array<AccountModel> | undefined {
  const models = conn.models
  if (models === undefined || models === null) return undefined
  if (models.length === 0) return []
  return models.map((m) => mappingToAccountModel(m))
}

// ── 导出序列化 ───────────────────────────────────────────────────

/**
 * 从 credential / context / credentialExtras 重组 provider-specific 凭据 record。
 * 导出与 `buildCredentials`(旧 connectionToAccount)同形。
 */
function connectionCredentialRecord(
  conn: ProviderConnection,
  provider: string,
): Record<string, unknown> {
  const cred = conn.credentials[0]
  if (!cred) return {}
  const credentials: Record<string, unknown> = {}
  const ctx = cred.context
  if (cred.value) {
    if (provider === "codebuff") credentials.authToken = cred.value
    else if (provider === "windsurf") credentials.apiKey = cred.value
    else if (provider === "mimo-aistudio") credentials.serviceToken = cred.value
    else if (provider === "codebuddy" || provider === "codebuddy-cn") {
      credentials.accessToken = cred.value
    } else if (provider === "lobsterai") credentials.accessToken = cred.value
    else if (isOAuthProviderId(provider)) credentials.accessToken = cred.value
  }
  if (ctx) {
    if (provider === "copilot" && typeof ctx.githubToken === "string") {
      credentials.githubToken = ctx.githubToken
    }
    if (provider === "codebuddy" || provider === "codebuddy-cn") {
      if (typeof ctx.refreshToken === "string") {
        credentials.refreshToken = ctx.refreshToken
      }
      if (typeof ctx.expiresAt === "number")
        credentials.expiresAt = ctx.expiresAt
    }
    if (provider === "lobsterai") {
      for (const key of [
        "refreshToken",
        "expiresAt",
        "uuid",
        "userId",
        "firstKeyfrom",
        "latestKeyfrom",
      ]) {
        if (ctx[key] !== undefined) credentials[key] = ctx[key]
      }
    }
    if (isOAuthProviderId(provider)) {
      for (const key of ["refreshToken", "idToken", "expiresAt"]) {
        if (ctx[key] !== undefined) credentials[key] = ctx[key]
      }
      if (typeof ctx.oauthAccountId === "string") {
        credentials.accountId = ctx.oauthAccountId
      }
      if (typeof ctx.projectId === "string")
        credentials.projectId = ctx.projectId
      if (typeof ctx.deviceId === "string") credentials.deviceId = ctx.deviceId
      if (typeof ctx.apiKey === "string") credentials.apiKey = ctx.apiKey
    }
  }
  const extraKeys = getConnectionCredentialExtras(conn)
  if (extraKeys) {
    for (const [key, value] of Object.entries(extraKeys)) {
      if (value !== undefined) credentials[key] = value
    }
  }
  return credentials
}

/**
 * 将 ProviderConnection 序列化为 `/admin/api/accounts/export` 的 JSON 形状。
 * 与 `ImportAccountPayload` 互为往返。
 */
export function serializeConnectionForExport(
  conn: ProviderConnection,
): Record<string, unknown> {
  const provider = getConnectionProvider(conn) ?? "copilot"
  const credentials = connectionCredentialRecord(conn, provider)
  const base: Record<string, unknown> = {
    id: conn.id,
    label: conn.name,
    provider,
    enabled: conn.enabled,
    priority: conn.priority,
    quotaState: getConnectionQuotaState(conn),
    quotaExhaustedAt: getConnectionQuotaExhaustedAt(conn),
    createdAt: conn.createdAt,
    availableModels: connectionModelsToAccountModels(conn),
    quotaInfo: getConnectionQuotaInfo(conn),
    cooldownUntil: getConnectionCooldownUntil(conn),
  }

  const settings = getConnectionSettings(conn) ?? {}
  if (provider === "copilot") {
    return {
      ...base,
      credentials: { githubToken: credentials.githubToken },
      settings,
    }
  }
  if (provider === "codebuff") {
    return {
      ...base,
      credentials: { authToken: credentials.authToken },
      settings,
    }
  }
  if (provider === "windsurf") {
    return { ...base, credentials: { apiKey: credentials.apiKey }, settings }
  }
  if (provider === "codebuddy" || provider === "codebuddy-cn") {
    return {
      ...base,
      credentials: {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
      },
      settings,
    }
  }
  if (provider === "lobsterai") {
    return {
      ...base,
      credentials: {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        uuid: credentials.uuid,
        userId: credentials.userId,
        firstKeyfrom: credentials.firstKeyfrom,
        latestKeyfrom: credentials.latestKeyfrom,
      },
      settings,
    }
  }
  if (isOAuthProviderId(provider)) {
    const cpaMetadata = getConnectionCpaMetadata(conn)
    return {
      ...base,
      credentials,
      settings,
      ...(cpaMetadata ? { cpaMetadata } : {}),
    }
  }
  return {
    ...base,
    credentials: {
      serviceToken: credentials.serviceToken,
      xiaomichatbotPh: credentials.xiaomichatbotPh,
      mimoWsToken: credentials.mimoWsToken,
    },
    settings,
  }
}
