/**
 * 配额刷新调度（应用级）。
 *
 * 原寄居在 `services/copilot/quota-refresh.ts`：调度与连接级刷新本是应用层
 * 职责，只有 Copilot 的用量获取是 provider 私有（现已下沉到
 * `lib/quota/fetchers/copilot.ts`，与其它 provider 的 fetcher 同形）。
 */
import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import {
  applyBalanceGate,
  resolveConnectionBalanceSource,
  syncConnectionBalance,
} from "~/lib/balance/sync"
import { logger } from "~/lib/logger"
import {
  listAccountManagedConnections,
  listProviderConnections,
  saveProviderConnections,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import { refreshManagedQuota } from "~/lib/quota/refresh"
import { initializeProviderRegistry } from "~/services/providers"
import { fetchCopilotQuota } from "~/lib/quota/fetchers/copilot"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { emitStateChange } from "~/lib/state-events"
import { globalTimers } from "~/lib/timer-registry"

const QUOTA_EXHAUSTION_THRESHOLD = 5
const QUOTA_RECHECK_INTERVAL_MS = 60 * 1000
/** How long a vendor's wallet endpoint is given to answer. */
const BALANCE_PROBE_TIMEOUT_MS = 15_000
/**
 * The least time between two reads of one connection's balance. The tick
 * already runs on the quota interval; this keeps any other trigger from
 * re-reading the same wallets.
 */
const BALANCE_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000

/**
 * copilot-native connection 的配额刷新。
 * 其它 protocol 返回 undefined，由各自 runtime 提供配额探测。
 */
export async function refreshQuotaForConnection(
  connection: ProviderConnection,
  skipSave = false,
  signal?: AbortSignal,
): Promise<QuotaSnapshot | undefined> {
  if (connection.protocol !== "copilot-native") {
    return undefined
  }

  const snapshot = await fetchCopilotQuota(connection, signal)
  const remaining = snapshot.premiumInteractionsRemaining ?? Infinity
  const unlimited = snapshot.unlimited
  const exhausted = !unlimited && remaining <= QUOTA_EXHAUSTION_THRESHOLD

  setConnectionQuotaInfo(connection, snapshot)
  const previousState = readQuotaState(connection)
  setConnectionQuotaState(connection, exhausted ? "exhausted" : "available")
  if (exhausted && previousState !== "exhausted") {
    logger.warn(`Connection "${connection.name}" quota exhausted`)
  } else if (!exhausted && previousState === "exhausted") {
    logger.info(
      `Connection "${connection.name}" quota refreshed — re-activating`,
    )
  }
  if (!exhausted) {
    // 配额恢复时同步清理内存限流器的残留冷却，否则路由仍会跳过该账号。
    clearAccountRateLimitState(connection.id)
  }
  if (!skipSave) {
    await saveProviderConnections(listProviderConnections())
    emitStateChange("models-stale")
  }
  return snapshot
}

/**
 * 定时检查所有支持配额的账号，按账号刷新间隔探测。
 */
export function scheduleQuotaRefresh(): void {
  initializeProviderRegistry()
  void refreshAllQuotas()
  globalTimers.interval(() => {
    void refreshAllQuotas()
  }, QUOTA_RECHECK_INTERVAL_MS)
}

let refreshing = false

export async function refreshAllQuotas(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    await refreshAllQuotasOnce()
  } catch (error) {
    logger.warn("Background quota refresh failed:", error)
  } finally {
    refreshing = false
  }
}

async function refreshAllQuotasOnce(): Promise<void> {
  const connections = listAccountManagedConnections().filter(
    (conn) =>
      conn.enabled
      && conn.credentials[0]?.enabled === true
      && conn.credentials[0]?.status !== "disabled",
  )
  for (let offset = 0; offset < connections.length; offset += 4) {
    const results = await Promise.allSettled(
      connections
        .slice(offset, offset + 4)
        .map(async (conn) => refreshManagedQuota(conn)),
    )
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("Failed to refresh quota for connection:", result.reason)
      }
    }
  }
  // Balances (a prepaid key, an account wallet) never enter the request path:
  // they are read here on the tick, and the result gates routing.
  await syncBalances()
  await saveProviderConnections(listProviderConnections())
  emitStateChange("models-stale")
}

/** When each connection's balance was last read (ms epoch). */
const lastBalanceSyncAt = new Map<string, number>()

/**
 * Read the balance of every connection that has a known source, and gate
 * routing on what came back.
 *
 * A balance at or below zero takes the connection out of scheduling (the
 * out-of-credit state: quota_exhausted, the same state failover uses for a 402
 * or an `insufficient balance` refusal) until a later read comes back positive.
 * Rate-limited per connection, and — beside the admin probe — the only place a
 * balance is fetched: the request path only ever reads memory.
 *
 * Returns how many connections were actually read.
 */
export async function syncBalances(now: number = Date.now()): Promise<number> {
  const connections = listProviderConnections()
  // Rate-limit records of deleted connections do not linger in memory.
  const live = new Set(connections.map((conn) => conn.id))
  for (const id of lastBalanceSyncAt.keys()) {
    if (!live.has(id)) lastBalanceSyncAt.delete(id)
  }

  const due = connections.filter((conn) => {
    if (!conn.enabled) return false
    if (resolveConnectionBalanceSource(conn) === undefined) {
      // Clean up locks persisted by a balance source that no longer applies.
      applyBalanceGate(conn)
      return false
    }
    const at = lastBalanceSyncAt.get(conn.id)
    return at === undefined || now - at >= BALANCE_SYNC_MIN_INTERVAL_MS
  })
  if (due.length === 0) return 0

  let read = 0
  const results = await Promise.allSettled(
    due.map(async (conn) => {
      lastBalanceSyncAt.set(conn.id, now)
      const balance = await syncConnectionBalance(
        conn,
        AbortSignal.timeout(BALANCE_PROBE_TIMEOUT_MS),
      )
      if (!balance) return
      read += 1
      const gate = applyBalanceGate(conn)
      if (!gate.changed) return
      if (gate.gated) {
        logger.warn(
          `Connection "${conn.name}" balance depleted (${balance.display}) — routing skips it`,
        )
      } else {
        logger.info(
          `Connection "${conn.name}" balance restored — re-activating`,
        )
      }
    }),
  )
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("Failed to sync connection balance:", result.reason)
    }
  }
  return read
}

/** Test-only: drop the balance read rate-limit bookkeeping. */
export function __resetBalanceSyncForTest(): void {
  lastBalanceSyncAt.clear()
}

function readQuotaState(connection: ProviderConnection): string {
  return (
    (connection.metadata as { quotaState?: string } | undefined)?.quotaState
    ?? "unknown"
  )
}
