/**
 * Copilot 配额刷新(connection 原生)。
 *
 * Phase 3:从 account-store.ts 提取的配额刷新逻辑。
 * Phase 5:refreshQuotaForAccount 直接从 connection 读取 quota 字段,
 * 不再经由 connectionToAccount 派生 Account 快照。
 */
import type { Account } from "~/lib/legacy-accounts"
import type {
  ProviderConnection,
  QuotaSnapshot,
} from "~/lib/provider-connections"

import { GITHUB_API_BASE_URL, githubApiHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { syncLegacyExhaustedState } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import {
  getConnectionExhaustedAt,
  getConnectionIsExhausted,
  getConnectionQuotaExhaustedAt,
  getConnectionQuotaInfo,
  getConnectionQuotaState,
  getMutableProviderConnection,
  listProviderConnections,
  saveProviderConnections,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import { emitStateChange } from "~/lib/state-events"
import { globalTimers } from "~/lib/timer-registry"

const QUOTA_EXHAUSTION_THRESHOLD = 5
const QUOTA_RECHECK_INTERVAL_MS = 5 * 60 * 1000

/**
 * copilot-native connection 的配额刷新。
 */
export async function refreshQuotaForConnection(
  connection: ProviderConnection,
  skipSave = false,
): Promise<QuotaSnapshot | undefined> {
  if (connection.protocol !== "copilot-native") {
    return undefined
  }

  const usage = await getCopilotUsageForConnection(connection)
  const snapshot = snapshotFromUsage(usage)
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
  if (!skipSave) {
    await saveProviderConnections(listProviderConnections())
    emitStateChange("models-stale")
  }
  return snapshot
}

/**
 * Account 桥接层:按 account.id 反查 connection 调原生实现。
 * Phase 5:直接从 connection 读取 quota 字段同步回 account,
 * 不再经由 connectionToAccount 派生完整 Account 快照。
 */
export async function refreshQuotaForAccount(
  account: Account,
  skipSave = false,
): Promise<void> {
  const connection = getMutableProviderConnection(account.id)
  if (!connection) {
    return
  }
  await refreshQuotaForConnection(connection, skipSave)
  // 直接从 connection 读取 quota 字段同步回 account
  account.quotaInfo = getConnectionQuotaInfo(connection)
  account.quotaState = getConnectionQuotaState(
    connection,
  ) as Account["quotaState"]
  account.quotaExhaustedAt = getConnectionQuotaExhaustedAt(connection)
  account.isExhausted = getConnectionIsExhausted(connection)
  account.exhaustedAt = getConnectionExhaustedAt(connection)
  syncLegacyExhaustedState(account)
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
  await saveProviderConnections(listProviderConnections())
  emitStateChange("models-stale")
}

function readQuotaState(connection: ProviderConnection): string {
  return (
    (connection.metadata as { quotaState?: string } | undefined)?.quotaState
    ?? "unknown"
  )
}

async function getCopilotUsageForConnection(
  connection: ProviderConnection,
): Promise<{
  quota_snapshots?: {
    premium_interactions?: {
      remaining: number
      entitlement: number
      unlimited: boolean
    }
    chat?: { remaining: number; entitlement: number; unlimited: boolean }
    completions?: { remaining: number; entitlement: number; unlimited: boolean }
  }
}> {
  const githubToken = readConnectionGithubToken(connection)
  if (!githubToken) {
    throw new Error(`GitHub token missing for connection "${connection.name}"`)
  }

  const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: {
      ...githubApiHeaders(),
      authorization: `token ${githubToken}`,
    },
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot usage", response)
  }

  return (await response.json()) as Awaited<
    ReturnType<typeof getCopilotUsageForConnection>
  >
}

function readConnectionGithubToken(
  connection: ProviderConnection,
): string | undefined {
  const token = connection.credentials[0]?.context?.githubToken
  return typeof token === "string" && token ? token : undefined
}

function snapshotFromUsage(
  usage: Awaited<ReturnType<typeof getCopilotUsageForConnection>>,
) {
  const snapshots = usage.quota_snapshots ?? {}
  const premium = snapshots.premium_interactions
  const chat = snapshots.chat
  const completions = snapshots.completions

  const unlimited = Boolean(
    premium?.unlimited || chat?.unlimited || completions?.unlimited,
  )

  return {
    fetchedAt: Date.now(),
    premiumInteractionsRemaining: premium?.remaining,
    premiumInteractionsTotal: premium?.entitlement,
    chatRemaining: chat?.remaining,
    chatTotal: chat?.entitlement,
    completionsRemaining: completions?.remaining,
    completionsTotal: completions?.entitlement,
    unlimited,
  }
}
