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
import { noteReadingFailure } from "~/lib/plan-quota/apply"
import {
  isOAuthConnection,
  listProviderConnections,
  saveProviderConnections,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import { applyOAuthQuotaSnapshot, fetchOAuthProviderQuota } from "~/lib/quota"
import { fetchCopilotQuota } from "~/lib/quota/fetchers/copilot"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { emitStateChange } from "~/lib/state-events"
import { globalTimers } from "~/lib/timer-registry"

const QUOTA_EXHAUSTION_THRESHOLD = 5
const QUOTA_RECHECK_INTERVAL_MS = 5 * 60 * 1000
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
 * 其它 protocol 无此周期性探测，返回 undefined。
 */
export async function refreshQuotaForConnection(
  connection: ProviderConnection,
  skipSave = false,
): Promise<QuotaSnapshot | undefined> {
  if (connection.protocol !== "copilot-native") {
    return undefined
  }

  const snapshot = await fetchCopilotQuota(connection)
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
 * 定时刷新所有 copilot-native connection 的配额。
 */
export function scheduleQuotaRefresh(): void {
  void refreshAllQuotas()
  globalTimers.interval(() => {
    void refreshAllQuotas()
  }, QUOTA_RECHECK_INTERVAL_MS)
}

async function refreshAllQuotas(): Promise<void> {
  const connections = listProviderConnections().filter(
    (conn) => conn.protocol === "copilot-native",
  )
  const results = await Promise.allSettled(
    connections.map((conn) => refreshQuotaForConnection(conn, true)),
  )
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("Failed to refresh quota for connection:", result.reason)
    }
  }
  // OAuth 账号之前没有任何后台配额探测：一次耗尽后只能等 24h 自动恢复
  // 或手动点刷新。这里定期重探处于 quota_exhausted 的 OAuth 连接，
  // 上游窗口恢复（如 Codex 5h / Claude 5h）后自动重新参与调度。
  await refreshExhaustedOAuthQuotas()
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
    if (resolveConnectionBalanceSource(conn) === undefined) return false
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

/**
 * 重探所有处于 quota_exhausted 的 OAuth 连接。
 * 探测成功且上游显示有配额时，applyOAuthQuotaSnapshot 会把 credential
 * 恢复为 ready 并清理冷却；探测失败则保持耗尽状态不变。
 */
async function refreshExhaustedOAuthQuotas(): Promise<void> {
  const targets = listProviderConnections().filter(
    (conn) =>
      isOAuthConnection(conn)
      && conn.credentials[0]?.status === "quota_exhausted",
  )
  if (targets.length === 0) return
  const results = await Promise.allSettled(
    targets.map(async (conn) => {
      let snapshot: QuotaSnapshot | undefined
      try {
        snapshot = await fetchOAuthProviderQuota(conn)
      } catch (error) {
        // A transient probe failure must not lose the last known allowance:
        // hand the error to plan-quota, which replays the previous reading as
        // stale. The exhaust/retry semantics stay exactly as they were.
        await noteReadingFailure(conn, error)
        throw error
      }
      if (snapshot) {
        const wasExhausted = conn.credentials[0]?.status === "quota_exhausted"
        applyOAuthQuotaSnapshot(conn, snapshot)
        if (wasExhausted && conn.credentials[0]?.status !== "quota_exhausted") {
          logger.info(
            `Connection "${conn.name}" quota recovered — re-activating`,
          )
        }
      }
    }),
  )
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn(
        "Failed to refresh OAuth quota for connection:",
        result.reason,
      )
    }
  }
}

function readQuotaState(connection: ProviderConnection): string {
  return (
    (connection.metadata as { quotaState?: string } | undefined)?.quotaState
    ?? "unknown"
  )
}
