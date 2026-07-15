/**
 * connectionToAccount — ProviderConnection → Account 反向映射器。
 *
 * `accountToConnectionForPersistence` 的逆函数：从 ProviderConnection +
 * ApiCredential + metadata（含 AccountLegacyMetadata）反构造 Account。
 *
 * 过渡期承重墙：批次 1 用它从 stateRoot.connections 反构造 state.accounts，
 * 使 Account 保持为内存真相。
 *
 * runtimeState 不持久化（与 serializeAccount 现状一致），反构造时
 * runtimeState 仅从 credential.status / credential.lastError / credential.context
 * 恢复最小子集。
 */
import type { Account, AccountModel, AccountRuntimeState } from "~/lib/accounts"
import type { ProviderProtocol } from "~/lib/provider-connections/types"

import { isOAuthProviderId } from "~/lib/provider-config"
import { PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"

import type { ProviderConnection } from "./types"

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
} from "./connection-metadata"

/**
 * Protocol → ProviderId 反向映射。
 */
const PROTOCOL_TO_PROVIDER: Partial<Record<ProviderProtocol, string>> = {}
for (const [providerId, protocol] of Object.entries(PROVIDER_PROTOCOL_MAP)) {
  PROTOCOL_TO_PROVIDER[protocol] = providerId
}

/**
 * ModelMapping → AccountModel 反向映射。
 */
interface MappingToAccountModelInput {
  publicId: string
  upstreamId: string
  endpoints: Array<string>
  name: string | undefined
  vendor: string | undefined
  pickerEnabled: boolean | undefined
  pickerCategory: string | undefined
}

function mappingToAccountModel(
  input: MappingToAccountModelInput,
): AccountModel {
  const {
    publicId,
    upstreamId,
    endpoints,
    name,
    vendor,
    pickerEnabled,
    pickerCategory,
  } = input
  // 将 ModelEndpoint 转回 URL 路径形式
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
 * 从 connection.models 反构造 availableModels。
 */
function connectionModelsToAccountModels(
  conn: ProviderConnection,
): Array<AccountModel> | undefined {
  if (!conn.models || conn.models.length === 0) return undefined
  return conn.models.map((m) =>
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

/**
 * 从 credential.context 反构造 runtimeState（最小子集）。
 *
 * runtimeState 不持久化，但 credential.context 中的 copilotTokenExpiry /
 * windsurfJwt / windsurfJwtFetchedAt 可恢复部分运行时状态。
 */
function buildRuntimeState(
  conn: ProviderConnection,
): AccountRuntimeState | undefined {
  const cred = conn.credentials[0]

  const ctx = cred.context
  if (!ctx) {
    // 仍需恢复 authStatus / lastError
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

  // authStatus / lastError 从 metadata 恢复
  const authStatus = getConnectionAuthStatus(conn)
  const authError = getConnectionAuthError(conn)
  if (authStatus !== "ready") {
    runtime.authStatus = authStatus as AccountRuntimeState["authStatus"]
  }
  if (authError) {
    runtime.lastError = authError
  }

  // copilot
  if (typeof ctx.copilotTokenExpiry === "number") {
    runtime.copilotTokenExpiry = ctx.copilotTokenExpiry
  }
  // copilotToken 本身不持久化，但若 credential.value 存在且 refresherType 为 copilot-token，
  // 可恢复（迁移后 value 为空，靠 refresh 重新获取）
  if (cred.refresherType === "copilot-token" && cred.value) {
    runtime.copilotToken = cred.value
  }

  // windsurf
  if (typeof ctx.windsurfJwt === "string") {
    runtime.windsurfJwt = ctx.windsurfJwt
  }
  if (typeof ctx.windsurfJwtFetchedAt === "number") {
    runtime.windsurfJwtFetchedAt = ctx.windsurfJwtFetchedAt
  }

  if (Object.keys(runtime).length === 0) return undefined
  return runtime
}

/**
 * 从 credential + credentialExtras + context 反构造 credentials record。
 */
function buildCredentials(
  conn: ProviderConnection,
  provider: string,
): Record<string, unknown> | undefined {
  const cred = conn.credentials[0]

  const credentials: Record<string, unknown> = {}
  const ctx = cred.context

  // token 字段：从 credential.value 恢复（若非空）
  // 注意：copilot 的 token 是 runtimeState.copilotToken，不放入 credentials
  if (cred.value) {
    switch (provider) {
      case "copilot": {
        // copilot 的 credential.value 是 copilotToken（runtime），不放入 credentials
        // githubToken 从 context 恢复
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
        if (isOAuthProviderId(provider as never)) {
          credentials.accessToken = cred.value
        }
      }
    }
  }

  // 从 context 恢复 token 相关字段
  if (ctx) {
    if (provider === "copilot" && typeof ctx.githubToken === "string") {
      credentials.githubToken = ctx.githubToken
    }
    if (isOAuthProviderId(provider as never)) {
      if (typeof ctx.refreshToken === "string") {
        credentials.refreshToken = ctx.refreshToken
      }
      if (typeof ctx.idToken === "string") {
        credentials.idToken = ctx.idToken
      }
      if (typeof ctx.expiresAt === "number") {
        credentials.expiresAt = ctx.expiresAt
      }
      if (typeof ctx.oauthAccountId === "string") {
        credentials.accountId = ctx.oauthAccountId
      }
      if (typeof ctx.projectId === "string") {
        credentials.projectId = ctx.projectId
      }
      if (typeof ctx.deviceId === "string") {
        credentials.deviceId = ctx.deviceId
      }
      if (typeof ctx.apiKey === "string") {
        credentials.apiKey = ctx.apiKey
      }
    }
  }

  // 从 credentialExtras 恢复非 token 字段
  const extras = getConnectionCredentialExtras(conn)
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (value !== undefined) {
        credentials[key] = value
      }
    }
  }

  if (Object.keys(credentials).length === 0) return undefined
  return credentials
}

/**
 * 从 metadata 反构造 settings record。
 */
function buildSettings(
  conn: ProviderConnection,
): Record<string, unknown> | undefined {
  const settings = getConnectionSettings(conn)
  if (!settings) return undefined
  // settings 直接从 metadata.settings 恢复
  // 注意：proxyUrl/modelPrefix/tokenEndpoint/redirectUri 同时存在于 metadata 顶层
  // 和 metadata.settings 中（accountToConnectionForPersistence 同时写入两处）
  // 这里从 metadata.settings 恢复即可
  if (Object.keys(settings).length === 0) return undefined
  return { ...settings }
}

/**
 * 将 ProviderConnection 反构造为 Account。
 *
 * 这是 `accountToConnectionForPersistence` 的逆函数。
 * runtimeState 仅恢复最小子集（authStatus/lastError + context 中的时间戳）。
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

  // OAuth-specific
  const cpaMetadata = getConnectionCpaMetadata(connection)
  if (cpaMetadata !== undefined) {
    account.cpaMetadata = cpaMetadata
  }

  // credential.enabled → account.enabled（单 credential 模型下同步）
  if (cred.enabled !== connection.enabled) {
    account.enabled = cred.enabled
  }

  return account
}

// 导出 buildAccountLegacyMetadata 供 migrate-from-accounts.ts 使用

export { buildAccountLegacyMetadata } from "./connection-metadata"
