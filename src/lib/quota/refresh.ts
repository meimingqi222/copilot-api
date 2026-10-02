import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import { noteReadingFailure } from "~/lib/plan-quota/apply"
import { accountManagedProvider } from "~/lib/provider-connections"
import { getProviderRuntime } from "~/services/providers/registry"

interface QuotaRefreshState {
  attemptedAt: number
  pending?: Promise<QuotaSnapshot | undefined>
}

const refreshState = new WeakMap<ProviderConnection, QuotaRefreshState>()

export function refreshManagedQuota(
  connection: ProviderConnection,
  options: { force?: boolean; now?: number } = {},
): Promise<QuotaSnapshot | undefined> {
  const provider = accountManagedProvider(connection)
  const runtime = getProviderRuntime(provider)
  const refresh = runtime.refreshQuota?.bind(runtime)
  if (!refresh || !runtime.supports(connection, "quota")) {
    return Promise.resolve(undefined)
  }
  const now = options.now ?? Date.now()
  const previous = refreshState.get(connection)
  if (previous?.pending) return previous.pending
  let interval = provider === "claude" ? 15 * 60_000 : 5 * 60_000
  if (options.force) interval = 30_000
  const lastRead = Math.max(
    previous?.attemptedAt ?? 0,
    connection.credentials[0]?.quota?.fetchedAt ?? 0,
  )
  if (lastRead && now - lastRead < interval) {
    return Promise.resolve(connection.credentials[0]?.quota)
  }
  const entry: QuotaRefreshState = { attemptedAt: now }
  refreshState.set(connection, entry)
  entry.pending = Promise.resolve()
    .then(() => refresh(connection, AbortSignal.timeout(20_000)))
    .catch(async (error: unknown) => {
      await noteReadingFailure(connection, error)
      throw error
    })
    .finally(() => {
      entry.pending = undefined
    })
  return entry.pending
}
