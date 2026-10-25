/**
 * Provider Connection 模型自动发现调度器。
 *
 * 根据 connection.modelDiscovery 配置周期性调用对应 ProtocolAdapter.discoverModels
 * 并按 mode (merge / replace / manual-only) 合并到 connection.models。
 */

import { createLogger } from "~/lib/logger"
import { everyMs, runJob } from "~/lib/jobs"
import { globalTimers } from "~/lib/timer-registry"
import { getProtocolAdapter } from "~/services/protocols/registry"

import { anonymousCredentialFor } from "./anonymous-credential"
import {
  listProviderConnections,
  mergeDiscoveredModels,
  persistProviderConnections,
} from "./state"
import { DEFAULTS, type ModelMapping, type ProviderConnection } from "./types"

const logger = createLogger("connection")

const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000 // 每分钟扫描一次,看哪些 connection 需要刷新

let intervalHandle: ReturnType<typeof globalTimers.interval> | undefined
const inFlightConnections = new Set<string>()

async function refreshConnectionModels(
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

  const usable = connection.credentials.filter(
    (c) => c.enabled && c.status !== "auth_error" && c.status !== "disabled",
  )
  // 无密钥连接(免费车道):没有 credential 可挑,退回合成匿名凭据——
  // 否则后台发现只会留下一句 "no usable credential" 再也不刷。
  const credential =
    usable.length > 0 ?
      usable.reduce((best, c) =>
        (c.priority ?? 0) < (best.priority ?? 0) ? c : best,
      )
    : connection.credentials.length === 0 ? anonymousCredentialFor(connection)
    : undefined
  if (credential === undefined) {
    connection.lastModelDiscoveryError = "no usable credential"
    return
  }

  try {
    const discovered = await adapter.discoverModels({
      connection,
      credential,
      signal,
    })
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
    logger.info(
      `[provider-connections] discovered ${discovered.length} model(s) for "${connection.name}"`,
    )
  } catch (error) {
    connection.lastModelDiscoveryError = (error as Error).message
    await persistProviderConnections().catch((err: unknown) => {
      logger.debug(
        `Failed to persist discovery error: ${(err as Error).message}`,
      )
    })
    logger.warn(
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

  // merge: existing 优先(含 enabled 与改名),新发现的默认禁用追加
  // (空列表首次发现除外,保持开箱即用)。见 mergeDiscoveredModels。
  return mergeDiscoveredModels(existing, filtered).models
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

async function refreshAllConnectionModels(signal?: AbortSignal): Promise<void> {
  for (const connection of listProviderConnections()) {
    await refreshConnectionModels(connection, signal)
  }
}

/** 启动周期性扫描;每次扫描挑选到期的 connection 触发刷新。 */
export function scheduleConnectionModelDiscovery(): void {
  if (intervalHandle) return
  const info = {
    label: "Connection model discovery",
    schedule: everyMs(DEFAULT_CHECK_INTERVAL_MS),
  }
  // 启动时执行一次
  void runJob(
    "model-discovery",
    () => refreshAllConnectionModels(),
    info,
  ).catch((err: unknown) => {
    logger.warn("Failed to refresh all connection models on startup:", err)
  })

  intervalHandle = globalTimers.interval(() => {
    void runJob(
      "model-discovery",
      async () => {
        const now = Date.now()
        const due = listProviderConnections().filter((connection) => {
          const cfg = connection.modelDiscovery
          if (!cfg?.enabled || cfg.mode === "manual-only") return false
          const interval =
            cfg.intervalMs ?? DEFAULTS.MODEL_DISCOVERY_INTERVAL_MS
          return now - (connection.lastModelDiscoveryAt ?? 0) >= interval
        })
        await Promise.all(
          due.map((connection) =>
            refreshConnectionModels(connection).catch((err: unknown) => {
              logger.warn(
                `Failed to refresh models of "${connection.name}":`,
                err,
              )
            }),
          ),
        )
      },
      info,
    )
  }, DEFAULT_CHECK_INTERVAL_MS)
}
