/**
 * Provider Connection 内存状态管理。
 *
 * - 启动时从磁盘加载到内存。
 * - CRUD 操作通过串行化 mutation 修改内存并触发持久化。
 * - 提供按 id / credential 维度的查询。
 */

import { randomUUID } from "node:crypto"

import { logger } from "~/lib/logger"
import { emitStateChange } from "~/lib/state-events"

import { loadProviderConnections, saveProviderConnections } from "./store"
import {
  type ApiCredential,
  type CredentialAuthMode,
  DEFAULTS,
  type ModelDiscoveryConfig,
  type ModelEndpoint,
  type ModelMapping,
  type ProviderConnection,
  type ProviderProtocol,
} from "./types"

interface ConnectionStateRoot {
  connections: Array<ProviderConnection>
  loaded: boolean
}

const stateRoot: ConnectionStateRoot = {
  connections: [],
  loaded: false,
}

let mutationQueue: Promise<void> = Promise.resolve()
let persistenceEnabled = true

export async function initializeProviderConnections(): Promise<void> {
  if (stateRoot.loaded) return
  try {
    stateRoot.connections = await loadProviderConnections()
    stateRoot.loaded = true
    logger.info(
      `[provider-connections] loaded ${stateRoot.connections.length} connection(s)`,
    )
  } catch (error) {
    stateRoot.loaded = false
    logger.error(
      `[provider-connections] init failed: ${(error as Error).message}`,
    )
    throw error
  }
}

export function listProviderConnections(): Array<ProviderConnection> {
  return stateRoot.connections
}

export function getProviderConnection(
  id: string,
): ProviderConnection | undefined {
  return stateRoot.connections.find((c) => c.id === id)
}

export function findCredential(
  connectionId: string,
  credentialId: string,
): { connection: ProviderConnection; credential: ApiCredential } | undefined {
  const connection = getProviderConnection(connectionId)
  if (!connection) return undefined
  const credential = connection.credentials.find((c) => c.id === credentialId)
  if (!credential) return undefined
  return { connection, credential }
}

async function persist(): Promise<void> {
  if (!persistenceEnabled) return
  await saveProviderConnections(stateRoot.connections)
}

function cloneConnections(): Array<ProviderConnection> {
  return structuredClone(stateRoot.connections)
}

async function withMutation<T>(operation: () => T | Promise<T>): Promise<T> {
  const previous = cloneConnections()
  const run = mutationQueue
    .catch((error: unknown) => {
      logger.warn(
        `[provider-connections] mutation queue error: ${(error as Error).message}`,
      )
    })
    .then(async () => {
      try {
        const result = await operation()
        await persist()
        return result
      } catch (error) {
        stateRoot.connections = previous
        throw error
      }
    })
  mutationQueue = run.then(
    () => undefined,
    (error: unknown) => {
      logger.warn(
        `[provider-connections] mutation cleanup error: ${(error as Error).message}`,
      )
    },
  )
  return run
}

export interface CreateConnectionInput {
  id?: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  enabled?: boolean
  priority?: number
  weight?: number
  headers?: Record<string, string>
  modelDiscovery?: ModelDiscoveryConfig
  models?: Array<ModelMapping>
  credentials?: Array<CreateCredentialInput>
}

export interface CreateCredentialInput {
  id?: string
  label?: string
  authMode?: CredentialAuthMode
  headerName?: string
  value: string
  enabled?: boolean
  priority?: number
  weight?: number
}

export async function createConnection(
  input: CreateConnectionInput,
): Promise<ProviderConnection> {
  return withMutation(() => {
    const id = input.id ?? slugifyId(input.name) ?? randomUUID().slice(0, 8)
    if (stateRoot.connections.some((c) => c.id === id)) {
      throw new Error(`Connection with id "${id}" already exists`)
    }

    const now = Date.now()
    const connection: ProviderConnection = {
      id,
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      enabled: input.enabled ?? true,
      priority: input.priority ?? DEFAULTS.CONNECTION_PRIORITY,
      weight: input.weight ?? DEFAULTS.CONNECTION_WEIGHT,
      headers: input.headers,
      modelDiscovery: input.modelDiscovery,
      models: input.models,
      credentials: (input.credentials ?? []).map((c) =>
        createCredentialObject(c),
      ),
      createdAt: now,
    }

    stateRoot.connections.push(connection)
    return connection
  })
}

export interface UpdateConnectionInput {
  name?: string
  baseUrl?: string
  protocol?: ProviderProtocol
  enabled?: boolean
  priority?: number
  weight?: number
  headers?: Record<string, string> | null
  modelDiscovery?: ModelDiscoveryConfig | null
  models?: Array<ModelMapping> | null
}

export async function updateConnection(
  id: string,
  patch: UpdateConnectionInput,
): Promise<ProviderConnection> {
  return withMutation(() => {
    const connection = getProviderConnection(id)
    if (!connection) throw new Error(`Connection not found: ${id}`)
    const previousProtocol = connection.protocol

    if (patch.name !== undefined) connection.name = patch.name
    if (patch.baseUrl !== undefined) connection.baseUrl = patch.baseUrl
    if (patch.protocol !== undefined) connection.protocol = patch.protocol
    if (patch.enabled !== undefined) connection.enabled = patch.enabled
    if (patch.priority !== undefined) connection.priority = patch.priority
    if (patch.weight !== undefined) connection.weight = patch.weight
    if (patch.headers !== undefined) {
      connection.headers = patch.headers ?? undefined
    }
    if (patch.modelDiscovery !== undefined) {
      connection.modelDiscovery = patch.modelDiscovery ?? undefined
    }
    if (patch.models !== undefined) {
      connection.models = patch.models ?? undefined
    } else if (
      patch.protocol !== undefined
      && patch.protocol !== previousProtocol
      && connection.models
    ) {
      connection.models = normalizeModelEndpointsForProtocol(
        connection.models,
        patch.protocol,
      )
    }
    connection.updatedAt = Date.now()
    return connection
  })
}

function normalizeModelEndpointsForProtocol(
  models: Array<ModelMapping>,
  protocol: ProviderProtocol,
): Array<ModelMapping> {
  return models.map((model) => ({
    ...model,
    endpoints: normalizeEndpointsForProtocol(model.endpoints, protocol),
  }))
}

function normalizeEndpointsForProtocol(
  endpoints: Array<ModelEndpoint>,
  protocol: ProviderProtocol,
): Array<ModelEndpoint> {
  if (protocol === "anthropic-compatible") {
    return uniqueEndpoints(
      endpoints.map((endpoint) =>
        endpoint === "chat" ? "messages" : endpoint,
      ),
    )
  }
  if (protocol === "openai-compatible") {
    return uniqueEndpoints(
      endpoints.map((endpoint) =>
        endpoint === "messages" ? "chat" : endpoint,
      ),
    )
  }
  return endpoints
}

function uniqueEndpoints(
  endpoints: Array<ModelEndpoint>,
): Array<ModelEndpoint> {
  return [...new Set(endpoints)]
}

export async function deleteConnection(id: string): Promise<void> {
  await withMutation(() => {
    const idx = stateRoot.connections.findIndex((c) => c.id === id)
    if (idx === -1) throw new Error(`Connection not found: ${id}`)
    stateRoot.connections.splice(idx, 1)
  })
}

export async function addCredential(
  connectionId: string,
  input: CreateCredentialInput,
): Promise<ApiCredential> {
  return withMutation(() => {
    const connection = getProviderConnection(connectionId)
    if (!connection) throw new Error(`Connection not found: ${connectionId}`)
    const credential = createCredentialObject(input)
    if (connection.credentials.some((c) => c.id === credential.id)) {
      throw new Error(`Credential with id "${credential.id}" already exists`)
    }
    connection.credentials.push(credential)
    connection.updatedAt = Date.now()
    return credential
  })
}

export interface UpdateCredentialInput {
  label?: string
  authMode?: CredentialAuthMode
  headerName?: string
  value?: string
  enabled?: boolean
  priority?: number
  weight?: number
}

export async function updateCredential(
  connectionId: string,
  credentialId: string,
  patch: UpdateCredentialInput,
): Promise<ApiCredential> {
  return withMutation(() => {
    const found = findCredential(connectionId, credentialId)
    if (!found) throw new Error(`Credential not found: ${credentialId}`)
    const { connection, credential } = found

    if (patch.label !== undefined) credential.label = patch.label
    if (patch.authMode !== undefined) credential.authMode = patch.authMode
    if (patch.headerName !== undefined) credential.headerName = patch.headerName
    if (patch.value !== undefined) credential.value = patch.value
    if (patch.enabled !== undefined) {
      credential.enabled = patch.enabled
      credential.status = patch.enabled ? "ready" : "disabled"
    }
    if (patch.priority !== undefined) credential.priority = patch.priority
    if (patch.weight !== undefined) credential.weight = patch.weight
    credential.updatedAt = Date.now()
    connection.updatedAt = Date.now()
    return credential
  })
}

export async function deleteCredential(
  connectionId: string,
  credentialId: string,
): Promise<void> {
  await withMutation(() => {
    const connection = getProviderConnection(connectionId)
    if (!connection) throw new Error(`Connection not found: ${connectionId}`)
    const idx = connection.credentials.findIndex((c) => c.id === credentialId)
    if (idx === -1) throw new Error(`Credential not found: ${credentialId}`)
    connection.credentials.splice(idx, 1)
    connection.updatedAt = Date.now()
  })
}

export async function applyDiscoveredModels(
  connectionId: string,
  discovered: Array<ModelMapping>,
  mode: "merge" | "replace" | "manual-only",
): Promise<void> {
  await withMutation(() => {
    const connection = getProviderConnection(connectionId)
    if (!connection) throw new Error(`Connection not found: ${connectionId}`)
    if (mode === "replace") {
      connection.models = discovered
    } else if (mode === "merge") {
      const existing = connection.models ?? []
      const map = new Map(existing.map((m) => [m.publicId, m]))
      for (const m of discovered) {
        if (!map.has(m.publicId)) map.set(m.publicId, m)
      }
      connection.models = [...map.values()]
    }
    // manual-only: 不修改 models
    connection.lastModelDiscoveryAt = Date.now()
    connection.lastModelDiscoveryError = undefined
    connection.updatedAt = Date.now()
  })
}

export async function setDiscoveryError(
  connectionId: string,
  errorMessage: string,
): Promise<void> {
  await withMutation(() => {
    const connection = getProviderConnection(connectionId)
    if (!connection) return
    connection.lastModelDiscoveryError = errorMessage
    connection.updatedAt = Date.now()
  })
}

export async function addModel(
  connectionId: string,
  model: ModelMapping,
): Promise<void> {
  await withMutation(() => {
    const connection = getProviderConnection(connectionId)
    if (!connection) throw new Error(`Connection not found: ${connectionId}`)
    if (connection.models?.some((m) => m.publicId === model.publicId)) {
      throw new Error(`Model "${model.publicId}" already exists`)
    }
    connection.models = [...(connection.models ?? []), model]
    connection.updatedAt = Date.now()
  })
}

export async function updateModel(
  connectionId: string,
  publicId: string,
  patch: Partial<
    Pick<
      ModelMapping,
      "publicId" | "upstreamId" | "name" | "vendor" | "endpoints" | "enabled"
    >
  >,
): Promise<ModelMapping> {
  return withMutation(() => {
    const connection = getProviderConnection(connectionId)
    if (!connection) throw new Error(`Connection not found: ${connectionId}`)
    const model = connection.models?.find((m) => m.publicId === publicId)
    if (!model) throw new Error(`Model "${publicId}" not found`)
    // 重命名 publicId: 校验非空 + 不与同 connection 内其他模型冲突
    if (patch.publicId !== undefined && patch.publicId !== publicId) {
      const newId = patch.publicId.trim()
      if (!newId) throw new Error("publicId must not be empty")
      const dup = connection.models?.find(
        (m) => m.publicId === newId && m !== model,
      )
      if (dup)
        throw new Error(`Model "${newId}" already exists in this connection`)
      model.publicId = newId
    }
    if (patch.upstreamId !== undefined) model.upstreamId = patch.upstreamId
    if (patch.name !== undefined) model.name = patch.name
    if (patch.vendor !== undefined) model.vendor = patch.vendor
    if (patch.endpoints !== undefined && patch.endpoints.length > 0)
      model.endpoints = patch.endpoints
    if (patch.enabled !== undefined) model.enabled = patch.enabled
    connection.updatedAt = Date.now()
    return model
  })
}

export async function deleteModel(
  connectionId: string,
  publicId: string,
): Promise<void> {
  await withMutation(() => {
    const connection = getProviderConnection(connectionId)
    if (!connection) throw new Error(`Connection not found: ${connectionId}`)
    const idx =
      connection.models?.findIndex((m) => m.publicId === publicId) ?? -1
    if (idx < 0) throw new Error(`Model "${publicId}" not found`)
    connection.models?.splice(idx, 1)
    connection.updatedAt = Date.now()
  })
}

/** 持久化当前内存状态(供 availability / discovery 运行时改动后调用)。 */
export async function persistProviderConnections(): Promise<void> {
  const run = mutationQueue
    .catch((error: unknown) => {
      logger.warn(
        `[provider-connections] persist queue error: ${(error as Error).message}`,
      )
    })
    .then(async () => {
      await persist()
    })
  mutationQueue = run.then(
    () => undefined,
    (error: unknown) => {
      logger.warn(
        `[provider-connections] persist cleanup error: ${(error as Error).message}`,
      )
    },
  )
  await run
  // 持久化完成后通知 models-stale,触发 cacheModels() 重建缓存
  emitStateChange("models-stale")
}

function createCredentialObject(input: CreateCredentialInput): ApiCredential {
  const id = input.id ?? randomUUID().slice(0, 8)
  const enabled = input.enabled ?? true
  return {
    id,
    label: input.label,
    authMode: input.authMode ?? "bearer",
    headerName: input.headerName,
    value: input.value,
    enabled,
    priority: input.priority ?? DEFAULTS.CREDENTIAL_PRIORITY,
    weight: input.weight ?? DEFAULTS.CREDENTIAL_WEIGHT,
    status: enabled ? "ready" : "disabled",
    createdAt: Date.now(),
  }
}

function slugifyId(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
  return slug === "" ? undefined : slug
}

/** 仅供测试重置内部状态。 */
export function __resetProviderConnectionsForTest(): void {
  stateRoot.connections = []
  stateRoot.loaded = false
  mutationQueue = Promise.resolve()
  persistenceEnabled = false
}
