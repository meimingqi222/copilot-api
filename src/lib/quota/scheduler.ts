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
import { createLogger } from "~/lib/logger"
import { runWithLogContext } from "~/lib/log-context"
import {
  listAccountManagedConnections,
  listProviderConnections,
  saveProviderConnections,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import { refreshManagedQuota } from "~/lib/quota/refresh"
import { liftRestAfterQuotaRecovery } from "~/lib/quota/recovery"
import { autoResetExpiringCodexQuota } from "~/lib/quota/codex-reset"
import { runAccountWarmups } from "~/lib/quota/warmup"
import { initializeProviderRegistry } from "~/services/providers"
import { runZcodeClaimRound } from "~/services/zcode/claim"
import { fetchCopilotQuota } from "~/lib/quota/fetchers/copilot"
import { clearAccountPacingState } from "~/lib/rate-limit"
import { emitStateChange } from "~/lib/state-events"
import { everyMs, runJob } from "~/lib/jobs"
import { globalTimers } from "~/lib/timer-registry"

const logger = createLogger("quota")

const QUOTA_EXHAUSTION_THRESHOLD = 5
const QUOTA_RECHECK_INTERVAL_MS = 60 * 1000
/**
 * ZCode 领取轮的节拍。轮内每个账号自己按 60 分钟去重（1005 名额等待期会
 * 更早重试），这里只负责及时把到期账号捞起来，不用每 5 分钟打上游。
 */
const ZCODE_CLAIM_TICK_MS = 5 * 60 * 1000
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
    // credential 上持久化的 cooldownUntil 和 rest 注册表同样要解除。
    clearAccountPacingState(connection.id)
    liftRestAfterQuotaRecovery(connection)
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
  const quota = () =>
    runJob("quota-refresh", refreshAllQuotas, {
      label: "Quota refresh",
      schedule: everyMs(QUOTA_RECHECK_INTERVAL_MS),
    })
  const warmup = () =>
    runJob("account-warmup", runAccountWarmups, {
      label: "Account warm-up",
      schedule: everyMs(30_000),
    })
  const claim = () =>
    runJob("zcode-claim", () => runZcodeClaimRound(), {
      label: "ZCode plan claim",
      schedule: everyMs(ZCODE_CLAIM_TICK_MS),
    })
  void quota()
  void warmup()
  globalTimers.interval(() => void warmup().catch(() => {}), 30_000)
  globalTimers.interval(
    () => void quota().catch(() => {}),
    QUOTA_RECHECK_INTERVAL_MS,
  )
  globalTimers.timeout(() => void claim().catch(() => {}), 60_000)
  globalTimers.interval(() => void claim().catch(() => {}), ZCODE_CLAIM_TICK_MS)
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

/**
 * Fields the tick may mutate. Persist + models-stale emit only happen when a
 * fingerprint actually changes — a quiet tick otherwise rewrites the whole
 * connections file and notifies every watcher for nothing.
 */
function connectionFingerprint(conn: ProviderConnection): string {
  return JSON.stringify(conn)
}

const QUOTA_REFRESH_WORKERS = 4

async function refreshAllQuotasOnce(): Promise<void> {
  const connections = listAccountManagedConnections().filter(
    (conn) =>
      conn.enabled
      && conn.credentials[0]?.enabled === true
      && conn.credentials[0]?.status !== "disabled",
  )
  const fingerprints = new Map(
    listProviderConnections().map((conn) => [
      conn.id,
      connectionFingerprint(conn),
    ]),
  )
  // Fixed worker pool: a slow connection no longer holds the whole batch
  // (chunked Promise.all waited for the slowest member of each batch).
  const queue = [...connections]
  await Promise.all(
    Array.from({ length: QUOTA_REFRESH_WORKERS }, async () => {
      for (let conn = queue.shift(); conn; conn = queue.shift()) {
        const connection = conn
        await runWithLogContext({ conn: connection.id }, async () => {
          try {
            await refreshManagedQuota(connection)
          } catch (error) {
            logger.warn("Failed to refresh quota for connection:", error)
          }
          try {
            await autoResetExpiringCodexQuota(connection)
          } catch (error) {
            logger.warn(
              `Failed to automatically reset Codex quota for "${connection.name}":`,
              error,
            )
          }
        })
      }
    }),
  )
  // Balances (a prepaid key, an account wallet) never enter the request path:
  // they are read here on the tick, and the result gates routing.
  await syncBalances()
  const changed = listProviderConnections().some(
    (conn) => fingerprints.get(conn.id) !== connectionFingerprint(conn),
  )
  if (changed || fingerprints.size !== listProviderConnections().length) {
    await saveProviderConnections(listProviderConnections())
    emitStateChange("models-stale")
  }
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
    due.map((conn) =>
      runWithLogContext({ conn: conn.id }, async () => {
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
    ),
  )
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logger.warn("Failed to sync connection balance:", result.reason, {
        connectionId: due[index].id,
      })
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
