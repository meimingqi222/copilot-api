import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import { logger } from "~/lib/logger"
import { noteReadingFailure } from "~/lib/plan-quota/apply"
import { accountManagedProvider } from "~/lib/provider-connections"
import { getConnectionQuotaState } from "~/lib/provider-connections/connection-metadata"
import { clearRestsForCredential } from "~/lib/route-target/rest-registry"
import { getProviderRuntime } from "~/services/providers/registry"

interface QuotaRefreshState {
  attemptedAt: number
  pending?: Promise<QuotaSnapshot | undefined>
}

const refreshState = new WeakMap<ProviderConnection, QuotaRefreshState>()

/**
 * 上游的配额窗口可能比本地记录的更早恢复。配额刷新看到恢复到可用时,把本地
 * 的休息一起解除 —— 否则路由继续跳过该账号,客户端只会收到
 * `all providers are temporarily rate-limited`,直到本地记录的时间到期。
 *
 * 只解除临时性的休息(配额 / 限流):`auth_error` 是凭据问题,不能因为配额
 * 恢复就当成可用。返回是否真的解除了什么,便于只在有变化时记日志。
 */
export function liftRestAfterQuotaRecovery(
  connection: ProviderConnection,
): boolean {
  let lifted = false
  for (const credential of connection.credentials) {
    if (
      credential.status === "quota_exhausted"
      || credential.status === "cooldown"
    ) {
      credential.status = "ready"
      credential.cooldownUntil = undefined
      lifted = true
    }
    if (clearRestsForCredential(credential.id)) lifted = true
  }
  return lifted
}

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
  // 刷新前先记下配额状态:只有"耗尽 → 可用"这个真实的恢复跃迁才解除休息,
  // 一直可用的账号不会因为每分钟刷新又把限流休息清掉。
  const stateBefore = getConnectionQuotaState(connection)
  entry.pending = Promise.resolve()
    .then(() => refresh(connection, AbortSignal.timeout(20_000)))
    .then((snapshot) => {
      if (
        stateBefore === "exhausted"
        && getConnectionQuotaState(connection) === "available"
        && liftRestAfterQuotaRecovery(connection)
      ) {
        logger.info(
          `Connection "${connection.name}" quota reset upstream — local rest lifted`,
        )
      }
      return snapshot
    })
    .catch(async (error: unknown) => {
      await noteReadingFailure(connection, error)
      throw error
    })
    .finally(() => {
      entry.pending = undefined
    })
  return entry.pending
}
