/**
 * Provider Connection 模型自动发现调度器。
 *
 * 根据 connection.modelDiscovery 配置周期性调用对应 ProtocolAdapter.discoverModels
 * 并按 mode (merge / replace / manual-only) 合并到 connection.models。
 */

import consola from "consola"

import { cacheModels } from "~/lib/utils"
import { getProtocolAdapter } from "~/services/protocols/registry"

import { listProviderConnections, persistProviderConnections } from "./state"
import { DEFAULTS, type ModelMapping, type ProviderConnection } from "./types"

const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000 // 每分钟扫描一次,看哪些 connection 需要刷新

let intervalHandle: ReturnType<typeof setInterval> | undefined
const inFlightConnections = new Set<string>()

export async function refreshConnectionModels(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<void> {
  if (inFlightConnections.has(connection.id)) return
  inFlightConnections.add(connection.id)
  try {
    await refreshConnectionModelsUnsafe(connection, signal)
  } finally {
    inFlightConnections.delete(connection.id)
  }
}

async function refreshConnectionModelsUnsafe(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<void> {
  const discovery = connection.modelDiscovery
  if (!discovery?.enabled) return
  if (discovery.mode === "manual-only") return
  if (!connection.enabled) return

  const adapter = getProtocolAdapter(connection.protocol)
  if (!adapter?.discoverModels) return

  const credential = connection.credentials.find(
    (c) => c.enabled && c.status !== "auth_error" && c.status !== "disabled",
  )
  if (!credential) {
    connection.lastModelDiscoveryError = "no usable credential"
    return
  }

  try {
    const discovered = await adapter.discoverModels(
      connection,
      credential,
      signal,
    )
    connection.models = mergeModels(
      connection.models ?? [],
      discovered,
      discovery.mode ?? "merge",
      {
        include: discovery.include,
        exclude: discovery.exclude,
      },
    )
    connection.lastModelDiscoveryAt = Date.now()
    connection.lastModelDiscoveryError = undefined
    await persistProviderConnections()
    cacheModels()
    consola.info(
      `[provider-connections] discovered ${discovered.length} model(s) for "${connection.name}"`,
    )
  } catch (error) {
    connection.lastModelDiscoveryError = (error as Error).message
    await persistProviderConnections().catch(() => {})
    consola.warn(
      `[provider-connections] discovery failed for "${connection.name}": ${(error as Error).message}`,
    )
  }
}

function mergeModels(
  existing: Array<ModelMapping>,
  discovered: Array<ModelMapping>,
  mode: "merge" | "replace" | "manual-only",
  filter: { include?: Array<string>; exclude?: Array<string> },
): Array<ModelMapping> {
  const filtered = discovered.filter((m) => {
    if (
      filter.include
      && filter.include.length > 0
      && !filter.include.some((p) => matchPattern(m.publicId, p))
    )
      return false
    if (
      filter.exclude
      && filter.exclude.some((p) => matchPattern(m.publicId, p))
    )
      return false
    return true
  })

  if (mode === "replace") {
    const manualMap = new Map(
      existing
        .filter((m) => m.metadata?.manual === true)
        .map((m) => [m.publicId, m]),
    )
    const result = [...filtered]
    for (const [, m] of manualMap) {
      if (!result.some((x) => x.publicId === m.publicId)) result.push(m)
    }
    return result
  }

  // merge: existing 优先,但补充新发现的
  const byId = new Map(existing.map((m) => [m.publicId, m]))
  for (const m of filtered) {
    if (!byId.has(m.publicId)) byId.set(m.publicId, m)
  }
  return Array.from(byId.values())
}

function matchPattern(value: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const re = new RegExp(
      "^"
        + pattern
          .replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)
          .replaceAll("*", ".*")
        + "$",
      "i",
    )
    return re.test(value)
  }
  return value.toLowerCase() === pattern.toLowerCase()
}

export async function refreshAllConnectionModels(
  signal?: AbortSignal,
): Promise<void> {
  for (const connection of listProviderConnections()) {
    await refreshConnectionModels(connection, signal)
  }
}

/** 启动周期性扫描;每次扫描挑选到期的 connection 触发刷新。 */
export function scheduleConnectionModelDiscovery(): void {
  if (intervalHandle) return
  // 启动时执行一次
  void refreshAllConnectionModels().catch(() => {})

  intervalHandle = setInterval(() => {
    const now = Date.now()
    for (const connection of listProviderConnections()) {
      const cfg = connection.modelDiscovery
      if (!cfg?.enabled) continue
      if (cfg.mode === "manual-only") continue
      const interval = cfg.intervalMs ?? DEFAULTS.MODEL_DISCOVERY_INTERVAL_MS
      const last = connection.lastModelDiscoveryAt ?? 0
      if (now - last >= interval) {
        void refreshConnectionModels(connection).catch(() => {})
      }
    }
  }, DEFAULT_CHECK_INTERVAL_MS)
}

export function stopConnectionModelDiscovery(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = undefined
  }
}
