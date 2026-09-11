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

import { refreshConnectionAvailability } from "./availability"
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
    // 启动时对所有 connection 做 availability refresh,
    // 把已过期的 cooldown / quota_exhausted 自动恢复为 ready。
    // 这覆盖了外部 provider connection(account-store 的
    // normalizeAllConnectionRuntimeFields 只处理 account connection)。
    for (const conn of stateRoot.connections) {
      refreshConnectionAvailability(conn)
    }
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

/**
 * 批次 1 过渡期：从 loadAccounts() 内部调用，设置 connections 内存状态。
 *
 * 当 loadAccounts() 执行首次迁移或强制重迁移后，需要将合并后的 connections
 * 写入 stateRoot。此函数直接设置 stateRoot.connections + loaded 标志，
 * 使后续的 initializeProviderConnections() 成为 no-op。
 */
export function setProviderConnectionsForMigration(
  connections: Array<ProviderConnection>,
): void {
  stateRoot.connections = connections
  stateRoot.loaded = true
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
      models:
        input.models ?
          normalizeModelEndpointsForProtocol(input.models, input.protocol)
        : input.models,
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
  if (
    protocol === "openai-compatible"
    || protocol === "openai-responses-compatible"
  ) {
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

/**
 * 模型命名冲突错误。路由层映射为 409(与“不存在”的 404 区分)。
 */
export class ModelConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelConflictError"
  }
}

/**
 * 别名冲突检查:新 publicId 不得撞到同 connection 内其他模型的别名;
 * 新别名不得撞到其他模型的 publicId/别名(与自身 publicId 相同者无害,跳过)。
 * publicId 撞 publicId 由调用方原有检查覆盖,这里只查别名相关交叉。
 * 命中抛 ModelConflictError。
 */
function assertNoAliasCollision(
  models: Array<ModelMapping> | undefined,
  self: ModelMapping | undefined,
  newPublicId: string,
  newAliases: Array<string> | undefined,
): void {
  const selfId = newPublicId.toLowerCase()
  for (const m of models ?? []) {
    if (m === self) continue
    if ((m.aliases ?? []).some((a) => a.toLowerCase() === selfId)) {
      throw new ModelConflictError(
        `Name "${newPublicId}" is already used by model "${m.publicId}" in this connection`,
      )
    }
    for (const a of newAliases ?? []) {
      if (a.toLowerCase() === selfId) continue
      if (m.publicId.toLowerCase() === a.toLowerCase()) {
        throw new ModelConflictError(
          `Name "${a}" is already used by model "${m.publicId}" in this connection`,
        )
      }
      const hit = (m.aliases ?? []).find(
        (x) => x.toLowerCase() === a.toLowerCase(),
      )
      if (hit !== undefined) {
        throw new ModelConflictError(
          `Name "${a}" is already used by model "${m.publicId}" in this connection`,
        )
      }
    }
  }
}

/**
 * 归一化模型别名输入:去空、去重(大小写不敏感)、截断防滥用。
 * 返回 undefined 表示输入非法/缺失(调用方保持原值);
 * 返回空数组表示清空。
 */
export function normalizeModelAliases(
  input: unknown,
): Array<string> | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) return undefined
  const out: Array<string> = []
  for (const item of input) {
    if (typeof item !== "string") continue
    const v = item.trim()
    if (!v || v.length > 120) continue
    if (out.some((x) => x.toLowerCase() === v.toLowerCase())) continue
    out.push(v)
    if (out.length >= 20) break
  }
  return out
}

/**
 * Provider 刷新模型合并:provider 侧全量覆盖时保留用户层配置。
 * 按 upstreamId(回退 publicId)匹配:
 * - 用户改名:保留改名。判定以 metadata.renamedByUser 显式标记为准,
 *   publicId!==upstreamId 字符串启发式仅作存量兼容(标记位引入前的改名)。
 * - 用户禁用(enabled=false):粘性保留
 * - 用户别名:保留
 * 空列表(新账号首次加载)直接采用上游原值。
 */
export function mergeProviderRefreshedModels(
  existing: Array<ModelMapping> | null | undefined,
  fresh: Array<ModelMapping>,
): Array<ModelMapping> {
  if (!existing || existing.length === 0) return fresh

  // Primary key is publicId. Fallback key includes the hidden flag so a head
  // mapping and a hidden pin that share an upstreamId (opaque default-effort
  // SKUs) never collapse onto the same prev — that used to rewrite the pin's
  // publicId to the head name and produce duplicates.
  const byPublicId = new Map<string, ModelMapping>()
  const byUpstreamKey = new Map<string, ModelMapping>()
  for (const m of existing) {
    const publicId = (m.publicId || "").toLowerCase()
    if (publicId && !byPublicId.has(publicId)) byPublicId.set(publicId, m)
    const upstreamKey = `${(m.upstreamId || m.publicId).toLowerCase()}::${m.hidden ? "1" : "0"}`
    if (!byUpstreamKey.has(upstreamKey)) byUpstreamKey.set(upstreamKey, m)
  }

  return fresh.map((f) => {
    const publicId = (f.publicId || "").toLowerCase()
    const upstreamKey = `${(f.upstreamId || f.publicId).toLowerCase()}::${f.hidden ? "1" : "0"}`
    const prev = byPublicId.get(publicId) ?? byUpstreamKey.get(upstreamKey)
    if (!prev) return f

    const explicitRename =
      (prev.metadata?.renamedByUser as boolean | undefined) === true
    // Legacy heuristic only when publicIds actually differ. Matching publicId
    // means nothing was renamed; comparing prev.publicId to prev.upstreamId
    // is wrong for opaque ids where they never match.
    const legacyRename =
      !explicitRename
      && prev.publicId !== f.publicId
      && prev.publicId !== prev.upstreamId
    const userRenamed = explicitRename || legacyRename

    return {
      ...f,
      ...(userRenamed ? { publicId: prev.publicId } : {}),
      ...(prev.enabled === false ? { enabled: false } : {}),
      ...(prev.aliases?.length ? { aliases: prev.aliases } : {}),
      ...(prev.hiddenAliases?.length ?
        { hiddenAliases: prev.hiddenAliases }
      : {}),
    }
  })
}

/**
 * Merge 语义的模型合并:已存在的模型原样保留(含 enabled 与改名),
 * 新发现的追加 —— 列表非空时默认禁用 + 对 picker 隐藏,
 * 避免自动发现淹没用户手工维护的启用选择;
 * 空列表(首次发现)保持上游原值,保留开箱即用体验。
 *
 * 判重同时比对 publicId 与 upstreamId:用户改名后,上游原名不再
 * 被当成“新模型”加回来(比对大小写不敏感,上游 id 大小写偶发漂移)。
 */
export function mergeDiscoveredModels(
  existing: Array<ModelMapping>,
  discovered: Array<ModelMapping>,
): { models: Array<ModelMapping>; added: number } {
  const byId = new Map(existing.map((m) => [m.publicId, m]))
  const byUpstream = new Set(
    existing.map((m) => (m.upstreamId || m.publicId).toLowerCase()),
  )
  let added = 0
  for (const m of discovered) {
    if (byId.has(m.publicId)) continue
    if (byUpstream.has((m.upstreamId || m.publicId).toLowerCase())) continue
    byId.set(
      m.publicId,
      existing.length > 0 ? { ...m, enabled: false, pickerEnabled: false } : m,
    )
    added++
  }
  return { models: [...byId.values()], added }
}

export async function applyDiscoveredModels(
  connectionId: string,
  discovered: Array<ModelMapping>,
  mode: "merge" | "replace" | "manual-only",
): Promise<{ added: number }> {
  return withMutation(() => {
    const connection = getProviderConnection(connectionId)
    if (!connection) throw new Error(`Connection not found: ${connectionId}`)
    let added = 0
    if (mode === "replace") {
      const before = new Set((connection.models ?? []).map((m) => m.publicId))
      connection.models = discovered
      added = discovered.filter((m) => !before.has(m.publicId)).length
    } else if (mode === "merge") {
      const merged = mergeDiscoveredModels(connection.models ?? [], discovered)
      connection.models = merged.models
      added = merged.added
    }
    // manual-only: 不修改 models
    connection.lastModelDiscoveryAt = Date.now()
    connection.lastModelDiscoveryError = undefined
    connection.updatedAt = Date.now()
    return { added }
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
    assertNoAliasCollision(
      connection.models,
      undefined,
      model.publicId,
      model.aliases,
    )
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
      | "publicId"
      | "upstreamId"
      | "name"
      | "vendor"
      | "endpoints"
      | "enabled"
      | "aliases"
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
      // 显式改名标记:供刷新合并时权威判定(比字符串启发式可靠);
      // 改回与 upstreamId 一致时清除标记。
      const meta: Record<string, unknown> = { ...model.metadata }
      if (newId === model.upstreamId) delete meta.renamedByUser
      else meta.renamedByUser = true
      model.metadata = meta
    }
    if (patch.upstreamId !== undefined) model.upstreamId = patch.upstreamId
    if (patch.name !== undefined) model.name = patch.name
    if (patch.vendor !== undefined) model.vendor = patch.vendor
    if (patch.endpoints !== undefined && patch.endpoints.length > 0)
      model.endpoints = patch.endpoints
    if (patch.enabled !== undefined) model.enabled = patch.enabled
    if (patch.publicId !== undefined || patch.aliases !== undefined) {
      assertNoAliasCollision(
        connection.models,
        model,
        model.publicId,
        patch.aliases ?? model.aliases,
      )
    }
    if (patch.aliases !== undefined)
      model.aliases = patch.aliases.length > 0 ? patch.aliases : undefined
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

// ── 批次 2：同步 mutation helpers（替代 state.accounts.push/splice） ──
// 这些函数直接操作 stateRoot.connections，不经过 withMutation 串行化。
// 调用方负责后续 persistProviderConnections() 持久化。
// 用于 account-store.ts / admin routes 等需要在批量操作后统一持久化的场景。

/**
 * 按 id 插入或替换 connection（upsert）。
 * 替代 state.accounts.push(account) + saveAccounts()。
 */
export function upsertProviderConnection(conn: ProviderConnection): void {
  const idx = stateRoot.connections.findIndex((c) => c.id === conn.id)
  if (idx !== -1) {
    stateRoot.connections[idx] = conn
  } else {
    stateRoot.connections.push(conn)
  }
}

/**
 * 按 id 移除 connection。
 * 替代 state.accounts.splice(idx, 1) + saveAccounts()。
 * 返回被移除的 connection，或 undefined（不存在时）。
 */
export function removeProviderConnection(
  id: string,
): ProviderConnection | undefined {
  const idx = stateRoot.connections.findIndex((c) => c.id === id)
  if (idx === -1) return undefined
  const [removed] = stateRoot.connections.splice(idx, 1)
  return removed
}

/**
 * 按 id 查找 connection 并返回可变引用（用于 in-place mutation）。
 * 替代 state.accounts.find(a => a.id === id)。
 */
export function getMutableProviderConnection(
  id: string,
): ProviderConnection | undefined {
  return stateRoot.connections.find((c) => c.id === id)
}

/**
 * 直接设置 connection.models(同步,不持久化)。
 * 供 ProviderRuntime.refreshModels 等需要直接写入模型列表的场景使用。
 * 调用方负责后续 persistProviderConnections()。
 */
export function setConnectionModels(
  conn: ProviderConnection,
  models: Array<ModelMapping>,
): void {
  conn.models = models
  conn.lastModelDiscoveryAt = Date.now()
  conn.lastModelDiscoveryError = undefined
  conn.updatedAt = Date.now()
}
