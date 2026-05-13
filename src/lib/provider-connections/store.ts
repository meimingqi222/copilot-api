import consola from "consola"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"

import type { ApiCredential, ProviderConnection } from "./types"

import { DEFAULTS, isProviderProtocol } from "./types"

interface PersistedFile {
  version: 1
  connections: Array<ProviderConnection>
}

const FILE_VERSION = 1

/**
 * 从磁盘加载 Provider Connection 配置。文件不存在时返回空数组。
 * 损坏或格式不兼容时记录警告并返回空数组(避免阻塞启动)。
 */
export async function loadProviderConnections(): Promise<
  Array<ProviderConnection>
> {
  let raw: string
  try {
    raw = await fs.readFile(PATHS.PROVIDER_CONNECTIONS_PATH, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    consola.warn(
      `Failed to read provider-connections.json: ${(error as Error).message}`,
    )
    return []
  }

  if (raw.trim() === "") {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    consola.warn(
      `provider-connections.json is not valid JSON: ${(error as Error).message}`,
    )
    return []
  }

  if (!isPersistedFile(parsed)) {
    consola.warn("provider-connections.json has unexpected shape, ignoring.")
    return []
  }

  return parsed.connections
    .map((c) => normalizeConnection(c))
    .filter((c): c is ProviderConnection => c !== null)
}

export async function saveProviderConnections(
  connections: Array<ProviderConnection>,
): Promise<void> {
  const payload: PersistedFile = {
    version: FILE_VERSION,
    connections,
  }
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  const tmpPath = path.join(
    PATHS.APP_DIR,
    `.${path.basename(PATHS.PROVIDER_CONNECTIONS_PATH)}.${process.pid}.tmp`,
  )
  try {
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    })
    await fs.rename(tmpPath, PATHS.PROVIDER_CONNECTIONS_PATH)
    try {
      await fs.chmod(PATHS.PROVIDER_CONNECTIONS_PATH, 0o600)
    } catch {
      // chmod 在某些平台(Windows)上会失败,忽略
    }
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {})
    throw error
  }
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

function isPersistedFile(value: unknown): value is PersistedFile {
  if (typeof value !== "object" || value === null) return false
  const obj = value as Record<string, unknown>
  if (obj.version !== FILE_VERSION) return false
  if (!Array.isArray(obj.connections)) return false
  return true
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
    consola.warn(
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
  }
}
