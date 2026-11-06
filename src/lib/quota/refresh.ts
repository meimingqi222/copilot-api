import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderQuotaRefreshOptions } from "~/services/providers/runtime"

import { noteReadingFailure } from "~/lib/plan-quota/apply"
import {
  accountManagedProvider,
  getMutableProviderConnection,
  persistProviderConnections,
} from "~/lib/provider-connections"
import { applyOAuthQuotaSnapshot } from "~/lib/quota"
import { getProviderRuntime } from "~/services/providers/registry"

/** A poll may finish after deletion, auth rotation, or a response observation. */
function quotaRefreshIsCurrent(connection: ProviderConnection): () => boolean {
  const credential = connection.credentials.at(0)
  const value = credential?.value
  const context = JSON.stringify(credential?.context)
  const fetchedAt = credential?.quota?.fetchedAt ?? -Infinity
  return () =>
    getMutableProviderConnection(connection.id) === connection
    && connection.enabled
    && credential !== undefined
    && connection.credentials.at(0) === credential
    && credential.enabled
    && credential.status !== "disabled"
    && credential.value === value
    && JSON.stringify(credential.context) === context
    // Response events keep the poll's `fetchedAt`; only a newer reading wins.
    && (credential.quota?.fetchedAt ?? -Infinity) <= fetchedAt
}

/** Shared guarded fetch/apply boundary used by provider-owned runtimes. */
export async function refreshProviderQuota(
  connection: ProviderConnection,
  fetchQuota: (
    connection: ProviderConnection,
    signal?: AbortSignal,
  ) => Promise<ProviderQuotaSnapshot | undefined>,
  signal?: AbortSignal,
  options: ProviderQuotaRefreshOptions & {
    applySnapshot?(
      connection: ProviderConnection,
      snapshot: QuotaSnapshot,
    ): void
    /** Renew the provider's own token first, so that renewal is not a rotation. */
    prepare?(
      connection: ProviderConnection,
      signal?: AbortSignal,
    ): Promise<void>
  } = {},
): Promise<ProviderQuotaSnapshot | undefined> {
  let isCurrent = quotaRefreshIsCurrent(connection)
  if (!isCurrent()) return undefined
  if (options.prepare) {
    await options.prepare(connection, signal)
    isCurrent = quotaRefreshIsCurrent(connection)
    if (!isCurrent()) return undefined
  }
  const snapshot = await fetchQuota(connection, signal)
  if (!snapshot || signal?.aborted || !isCurrent()) return undefined
  const applySnapshot = options.applySnapshot ?? applyOAuthQuotaSnapshot
  applySnapshot(connection, snapshot)
  if (!options.skipSave) await persistProviderConnections()
  return snapshot
}

interface QuotaRefreshState {
  attemptedAt: number
  pending?: Promise<QuotaSnapshot | undefined>
}

const refreshState = new WeakMap<ProviderConnection, QuotaRefreshState>()

/**
 * 刷新配额。恢复（上游报告仍有额度）时的本地休息由各 provider 的
 * apply 路径调用 `liftRestAfterQuotaRecovery` 解除 —— 状态能在那里随快照一起落库，
 * 这里只负责节流、合并并发读和失败记账。
 */
export function refreshManagedQuota(
  connection: ProviderConnection,
  options: { force?: boolean; now?: number } = {},
): Promise<QuotaSnapshot | undefined> {
  const provider = accountManagedProvider(connection)
  const runtime = getProviderRuntime(provider)
  const refresh = runtime.refreshQuota?.bind(runtime)
  const source = runtime.quota?.source
  if (!refresh || (source !== "poll" && source !== "poll-and-response")) {
    return Promise.resolve(undefined)
  }
  const now = options.now ?? Date.now()
  const previous = refreshState.get(connection)
  if (previous?.pending) return previous.pending
  let interval = runtime.quota?.refreshIntervalMs ?? 5 * 60_000
  if (options.force) interval = 30_000
  const lastRead = Math.max(
    previous?.attemptedAt ?? 0,
    connection.credentials[0]?.quota?.fetchedAt ?? 0,
  )
  if (lastRead && now - lastRead < interval) {
    return Promise.resolve(connection.credentials[0]?.quota)
  }
  const entry: QuotaRefreshState = { attemptedAt: now }
  const isCurrent = quotaRefreshIsCurrent(connection)
  refreshState.set(connection, entry)
  entry.pending = Promise.resolve()
    .then(() => refresh(connection, AbortSignal.timeout(20_000)))
    .catch(async (error: unknown) => {
      if (isCurrent()) await noteReadingFailure(connection, error)
      throw error
    })
    .finally(() => {
      entry.pending = undefined
    })
  return entry.pending
}
