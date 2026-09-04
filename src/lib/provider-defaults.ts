/**
 * Direct provider default connection management (Phase 3)。
 *
 * 启动时根据 CLI / env 提供的 codebuff/windsurf 默认配置,自动同步一个
 * "managed default" connection 到 stateRoot.connections。已存在的 managed
 * default 会更新 settings;新配置会创建新 connection;不再配置的旧
 * connection 保留不动。
 *
 * 按 label + protocol 查找保持 id 稳定(与原 Account 路径行为一致)。
 */
import { randomUUID } from "node:crypto"

import { persistProviderConnections } from "~/lib/provider-connections"
import {
  ensureLegacyMetadata,
  getConnectionSettings,
  listProviderConnections,
  setCredentialValue,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"

import type { ProviderConnection } from "./provider-connections/types"

/**
 * 启动时同步 codebuff/windsurf 的 managed default connection。
 * 有变更时持久化到磁盘。
 */
export async function ensureDirectProviderConnections(): Promise<void> {
  let changed = false
  changed = syncCodebuffDefaultConnection() || changed
  changed = syncWindsurfDefaultConnection() || changed

  if (changed) {
    await persistProviderConnections()
  }
}

function syncCodebuffDefaultConnection(): boolean {
  const defaults = state.providerDefaults.codebuff
  if (!defaults.authToken) return false

  const managedDefault = findManagedDefault(
    "codebuff-native",
    "codebuff-default",
  )

  if (managedDefault) {
    let changed = false
    const cred = managedDefault.credentials[0]
    if (cred.value !== defaults.authToken) {
      setCredentialValue(managedDefault, defaults.authToken)
      changed = true
    }
    changed = applyCodebuffDefaultsIfChanged(managedDefault) || changed
    return changed
  }

  // 不存在同 token 的 connection → 创建
  const hasTokenConnection = listProviderConnections().some(
    (conn) =>
      conn.protocol === "codebuff-native"
      && conn.credentials[0]?.value === defaults.authToken,
  )
  if (!hasTokenConnection) {
    const conn = createCodebuffDefaultConnection()
    upsertManagedConnection(conn)
    return true
  }

  return false
}

function applyCodebuffDefaultsIfChanged(conn: ProviderConnection): boolean {
  const defaults = state.providerDefaults.codebuff
  const settings = getConnectionSettings(conn) as
    | Record<string, unknown>
    | undefined
  const nextSettings: Record<string, unknown> = {
    baseUrl: defaults.baseUrl,
    cliVersion: defaults.cliVersion,
    agentId: defaults.agentId,
    model: defaults.model,
    costMode: defaults.costMode,
    allowFallbacks: defaults.allowFallbacks,
  }
  if (settingsEqual(settings, nextSettings)) {
    return false
  }
  // 直接写 metadata.settings(支持 string/boolean/number 等非 string 值)
  const meta = ensureLegacyMetadata(conn)
  meta.settings = { ...meta.settings, ...nextSettings }
  return true
}

function createCodebuffDefaultConnection(): ProviderConnection {
  const defaults = state.providerDefaults.codebuff
  const authToken = defaults.authToken
  if (!authToken) throw new Error("codebuff authToken not configured")
  const id = randomUUID()
  return {
    id,
    name: "codebuff-default",
    protocol: "codebuff-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
    credentials: [
      {
        id,
        authMode: "bearer",
        value: authToken,
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
        refresherType: "static",
        context: { accountId: id },
      },
    ],
    metadata: {
      provider: "codebuff",
      quotaState: "unknown",
      settings: {
        baseUrl: defaults.baseUrl,
        cliVersion: defaults.cliVersion,
        agentId: defaults.agentId,
        model: defaults.model,
        costMode: defaults.costMode,
        allowFallbacks: defaults.allowFallbacks,
      },
    },
  }
}

function syncWindsurfDefaultConnection(): boolean {
  const defaults = state.providerDefaults.windsurf
  if (!defaults.apiKey) return false

  const managedDefault = findManagedDefault(
    "windsurf-native",
    "windsurf-default",
  )

  if (managedDefault) {
    let changed = false
    const cred = managedDefault.credentials[0]
    if (cred.value !== defaults.apiKey) {
      setCredentialValue(managedDefault, defaults.apiKey)
      changed = true
    }
    changed = applyWindsurfDefaultsIfChanged(managedDefault) || changed
    return changed
  }

  const hasKeyConnection = listProviderConnections().some(
    (conn) =>
      conn.protocol === "windsurf-native"
      && conn.credentials[0]?.value === defaults.apiKey,
  )
  if (!hasKeyConnection) {
    const conn = createWindsurfDefaultConnection()
    upsertManagedConnection(conn)
    return true
  }

  return false
}

function applyWindsurfDefaultsIfChanged(conn: ProviderConnection): boolean {
  const defaults = state.providerDefaults.windsurf
  const settings = getConnectionSettings(conn) as
    | Record<string, unknown>
    | undefined
  const nextSettings: Record<string, unknown> = {
    baseUrl: defaults.baseUrl,
    defaultModel: defaults.defaultModel,
  }
  if (settingsEqual(settings, nextSettings)) {
    return false
  }
  const meta = ensureLegacyMetadata(conn)
  meta.settings = { ...meta.settings, ...nextSettings }
  return true
}

function createWindsurfDefaultConnection(): ProviderConnection {
  const defaults = state.providerDefaults.windsurf
  const apiKey = defaults.apiKey
  if (!apiKey) throw new Error("windsurf apiKey not configured")
  const id = randomUUID()
  return {
    id,
    name: "windsurf-default",
    protocol: "windsurf-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
    credentials: [
      {
        id,
        authMode: "bearer",
        value: apiKey,
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
        refresherType: "windsurf-jwt",
        context: { accountId: id },
      },
    ],
    metadata: {
      provider: "windsurf",
      quotaState: "unknown",
      settings: {
        baseUrl: defaults.baseUrl,
        defaultModel: defaults.defaultModel,
      },
    },
  }
}

/**
 * 按 label + protocol 查找 managed default connection。
 * 保持 id 稳定(与原 Account 路径按 label 匹配行为一致)。
 */
function findManagedDefault(
  protocol: ProviderConnection["protocol"],
  name: string,
): ProviderConnection | undefined {
  return listProviderConnections().find(
    (conn) => conn.protocol === protocol && conn.name === name,
  )
}

/**
 * 插入 managed default connection(直接操作 stateRoot)。
 * conn 由调用方通过 randomUUID() 新建,getMutableProviderConnection 查找
 * 是冗余的(新 id 不可能已存在),但保留 push 语义即可。
 */
function upsertManagedConnection(conn: ProviderConnection): void {
  listProviderConnections().push(conn)
}

function settingsEqual(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right)
}
