import fs from "node:fs/promises"

import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { Repository } from "~/lib/repository"

import type { CredentialRefresherType } from "./credential-refresher"
import type { ApiCredential, ProviderConnection } from "./types"

import { DEFAULTS, isProviderProtocol } from "./types"

interface PersistedFileV1 {
  version: 1
  connections: Array<ProviderConnection>
}

interface PersistedFileV2 {
  version: 2
  connections: Array<ProviderConnection>
}

type PersistedFile = PersistedFileV1 | PersistedFileV2

const CURRENT_FILE_VERSION = 2
const SUPPORTED_VERSIONS = new Set([1, 2])

/**
 * 从磁盘加载 Provider Connection 配置。文件不存在时返回空数组。
 * 主文件或 .bak 存在但无法解析时抛出错误(与 accounts.json 恢复契约对齐)。
 */
const repo = new Repository<PersistedFile>({
  filePath: () => PATHS.PROVIDER_CONNECTIONS_PATH,
  serialize: (data) => JSON.stringify(data, null, 2),
  deserialize: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object"
      || parsed === null
      || !SUPPORTED_VERSIONS.has(
        (parsed as Record<string, unknown>).version as number,
      )
      || !Array.isArray((parsed as Record<string, unknown>).connections)
    ) {
      throw new Error("provider-connections.json has unexpected shape")
    }
    const file = parsed as PersistedFile
    // 懒升级:v1 → v2(下次保存时自动写回 v2)
    if (file.version === 1) {
      file.connections = file.connections.map((c) => upgradeConnectionV1ToV2(c))
      ;(file as unknown as PersistedFileV2).version = 2
    }
    return file as PersistedFileV2
  },
})

async function providerConnectionsRecoverableOnDisk(): Promise<boolean> {
  for (const filePath of [
    PATHS.PROVIDER_CONNECTIONS_PATH,
    `${PATHS.PROVIDER_CONNECTIONS_PATH}.bak`,
  ]) {
    try {
      const raw = await fs.readFile(filePath, "utf8")
      if (raw.trim().length > 0) {
        return true
      }
    } catch {
      // missing or unreadable — try next path
    }
  }
  return false
}

export async function loadProviderConnections(): Promise<
  Array<ProviderConnection>
> {
  const file = await repo.load()
  if (!file) {
    if (await providerConnectionsRecoverableOnDisk()) {
      throw new Error(
        "Could not load provider-connections.json: recoverable data exists on disk but is corrupt or unreadable. Restore from backup or remove the file to start fresh.",
      )
    }
    return []
  }
  return file.connections
    .map((c) => normalizeConnection(c))
    .filter((c): c is ProviderConnection => c !== null)
}

export async function saveProviderConnections(
  connections: Array<ProviderConnection>,
): Promise<void> {
  await repo.save({
    version: CURRENT_FILE_VERSION,
    connections,
  })
}

/**
 * 返回脱敏副本:credential.value 替换为尾号 + hasSecret 标记。
 * 用于 admin API 列表/详情响应,避免 secret 外泄。
 */
export function sanitizeConnection(
  connection: ProviderConnection,
): SanitizedConnection {
  return {
    ...connection,
    credentials: connection.credentials.map((c) => sanitizeCredential(c)),
  }
}

export function sanitizeCredential(
  credential: ApiCredential,
): SanitizedCredential {
  const { value, ...rest } = credential
  return {
    ...rest,
    hasSecret: typeof value === "string" && value.length > 0,
    secretPreview: previewSecret(value),
  }
}

function previewSecret(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed.length <= 6) return `***${trimmed.slice(-2)}`
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-4)}`
}

export type SanitizedCredential = Omit<ApiCredential, "value"> & {
  hasSecret: boolean
  secretPreview?: string
}

export type SanitizedConnection = Omit<ProviderConnection, "credentials"> & {
  credentials: Array<SanitizedCredential>
}

function normalizeConnection(value: unknown): ProviderConnection | null {
  if (typeof value !== "object" || value === null) return null
  const obj = value as Record<string, unknown>

  if (typeof obj.id !== "string" || obj.id === "") return null
  if (typeof obj.name !== "string") return null
  if (typeof obj.protocol !== "string" || !isProviderProtocol(obj.protocol)) {
    return null
  }
  if (typeof obj.baseUrl !== "string") return null

  const credentials =
    Array.isArray(obj.credentials) ?
      obj.credentials
        .map((c) => normalizeCredential(c))
        .filter((c): c is ApiCredential => c !== null)
    : []

  return {
    id: obj.id,
    name: obj.name,
    protocol: obj.protocol,
    baseUrl: obj.baseUrl,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    priority:
      typeof obj.priority === "number" ?
        obj.priority
      : DEFAULTS.CONNECTION_PRIORITY,
    weight:
      typeof obj.weight === "number" ? obj.weight : DEFAULTS.CONNECTION_WEIGHT,
    headers:
      obj.headers && typeof obj.headers === "object" ?
        (obj.headers as Record<string, string>)
      : undefined,
    modelDiscovery:
      obj.modelDiscovery && typeof obj.modelDiscovery === "object" ?
        (obj.modelDiscovery as ProviderConnection["modelDiscovery"])
      : undefined,
    models:
      Array.isArray(obj.models) ?
        (obj.models as ProviderConnection["models"])
      : undefined,
    credentials,
    lastModelDiscoveryAt:
      typeof obj.lastModelDiscoveryAt === "number" ?
        obj.lastModelDiscoveryAt
      : undefined,
    lastModelDiscoveryError:
      typeof obj.lastModelDiscoveryError === "string" ?
        obj.lastModelDiscoveryError
      : undefined,
    createdAt: typeof obj.createdAt === "number" ? obj.createdAt : Date.now(),
    updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : undefined,
    metadata:
      obj.metadata && typeof obj.metadata === "object" ?
        (obj.metadata as Record<string, unknown>)
      : undefined,
    // T5.2.5 新增类型化字段
    proxyUrl: typeof obj.proxyUrl === "string" ? obj.proxyUrl : undefined,
    modelPrefix:
      typeof obj.modelPrefix === "string" ? obj.modelPrefix : undefined,
  }
}

function normalizeCredential(value: unknown): ApiCredential | null {
  if (typeof value !== "object" || value === null) return null
  const obj = value as Record<string, unknown>

  if (typeof obj.id !== "string" || obj.id === "") return null
  if (typeof obj.value !== "string") return null

  const legacyAuthMode =
    obj.authMode === "api-key-header" || obj.authMode === "custom-header"
  if (legacyAuthMode) {
    logger.warn(
      `[provider-connections] credential "${obj.id}" uses deprecated authMode "${String(obj.authMode)}", normalizing to "header"`,
    )
  }
  const authMode =
    obj.authMode === "header" || legacyAuthMode ? "header" : "bearer"

  const status =
    typeof obj.status === "string" ?
      (obj.status as ApiCredential["status"])
    : "ready"

  return {
    id: obj.id,
    label: typeof obj.label === "string" ? obj.label : undefined,
    authMode,
    headerName: typeof obj.headerName === "string" ? obj.headerName : undefined,
    value: obj.value,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    priority:
      typeof obj.priority === "number" ?
        obj.priority
      : DEFAULTS.CREDENTIAL_PRIORITY,
    weight:
      typeof obj.weight === "number" ? obj.weight : DEFAULTS.CREDENTIAL_WEIGHT,
    status,
    cooldownUntil:
      typeof obj.cooldownUntil === "number" ? obj.cooldownUntil : undefined,
    lastRateLimitAt:
      typeof obj.lastRateLimitAt === "number" ? obj.lastRateLimitAt : undefined,
    lastErrorAt:
      typeof obj.lastErrorAt === "number" ? obj.lastErrorAt : undefined,
    lastError: typeof obj.lastError === "string" ? obj.lastError : undefined,
    createdAt: typeof obj.createdAt === "number" ? obj.createdAt : Date.now(),
    updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : undefined,
    refresherType:
      typeof obj.refresherType === "string" ?
        (obj.refresherType as CredentialRefresherType)
      : undefined,
    context:
      obj.context && typeof obj.context === "object" ?
        (obj.context as Record<string, unknown>)
      : undefined,
    // T5.2.5 新增类型化字段
    quota:
      obj.quota && typeof obj.quota === "object" ?
        (obj.quota as ApiCredential["quota"])
      : undefined,
    exhaustedAt:
      typeof obj.exhaustedAt === "number" ? obj.exhaustedAt : undefined,
    lastRateLimitReason:
      typeof obj.lastRateLimitReason === "string" ?
        obj.lastRateLimitReason
      : undefined,
  }
}

/**
 * T5.2.5:将 v1 connection 的 metadata 字段提升为类型化本体字段(v2)。
 * 纯函数,幂等:对已经是 v2 形状的 connection 无副作用。
 *
 * 提升表:
 * - metadata.quotaInfo → credential.quota
 * - metadata.quotaExhaustedAt ?? metadata.exhaustedAt → credential.exhaustedAt
 * - metadata.lastRateLimitReason → credential.lastRateLimitReason
 * - metadata.proxyUrl → connection.proxyUrl
 * - metadata.modelPrefix → connection.modelPrefix
 * - metadata.cooldownUntil / lastRateLimitAt → 已在 credential 本体字段,删除 metadata 副本
 * - metadata.provider / quotaState / subtitle → 派生值,不提升(序列化时派生)
 */
export function upgradeConnectionV1ToV2(
  conn: ProviderConnection,
): ProviderConnection {
  const meta = conn.metadata as Record<string, unknown> | undefined
  if (!meta) return conn

  const result = { ...conn }
  const cred = result.credentials[0]
  if (cred) {
    const newCred = { ...cred }
    // quotaInfo → credential.quota
    if (
      !newCred.quota
      && meta.quotaInfo
      && typeof meta.quotaInfo === "object"
    ) {
      newCred.quota = meta.quotaInfo as ApiCredential["quota"]
    }
    // quotaExhaustedAt ?? exhaustedAt → credential.exhaustedAt
    if (newCred.exhaustedAt === undefined) {
      const exhaustedAt =
        (typeof meta.quotaExhaustedAt === "number" ?
          meta.quotaExhaustedAt
        : undefined)
        ?? (typeof meta.exhaustedAt === "number" ? meta.exhaustedAt : undefined)
      if (exhaustedAt !== undefined) {
        newCred.exhaustedAt = exhaustedAt
      }
    }
    // lastRateLimitReason → credential.lastRateLimitReason
    if (
      !newCred.lastRateLimitReason
      && typeof meta.lastRateLimitReason === "string"
    ) {
      newCred.lastRateLimitReason = meta.lastRateLimitReason
    }
    result.credentials = [newCred, ...result.credentials.slice(1)]
  }

  // proxyUrl → connection.proxyUrl
  if (typeof meta.proxyUrl === "string" && !result.proxyUrl) {
    result.proxyUrl = meta.proxyUrl
  }
  // modelPrefix → connection.modelPrefix
  if (typeof meta.modelPrefix === "string" && !result.modelPrefix) {
    result.modelPrefix = meta.modelPrefix
  }

  // 清理已提升的 metadata 键(幂等:已不存在的键跳过)
  const cleanedMeta = { ...meta }
  delete cleanedMeta.quotaInfo
  delete cleanedMeta.quotaExhaustedAt
  delete cleanedMeta.exhaustedAt
  delete cleanedMeta.lastRateLimitReason
  delete cleanedMeta.proxyUrl
  delete cleanedMeta.modelPrefix
  // cooldownUntil / lastRateLimitAt 已在 credential 本体字段,删除 metadata 副本
  delete cleanedMeta.cooldownUntil
  delete cleanedMeta.lastRateLimitAt
  result.metadata = cleanedMeta

  return result
}
