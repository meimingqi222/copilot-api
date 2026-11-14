import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import { noteSnapshotReading } from "~/lib/plan-quota/apply"
import { isOAuthProviderId } from "~/lib/provider-config"
import {
  getConnectionProvider,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import { liftRestAfterQuotaRecovery } from "~/lib/quota/recovery"
import { clearAccountPacingState } from "~/lib/rate-limit"
import { mergeQuotaAllowance, quotaAvailability } from "~/lib/quota/allowance"

/**
 * 拉取 OAuth provider 配额快照(connection 原生)。
 * 刷新材料与 access token 均从 connection credential 读取;
 * 非 OAuth connection 返回 undefined。
 */
export async function fetchOAuthProviderQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot | undefined> {
  const provider = getConnectionProvider(connection)
  if (!provider || !isOAuthProviderId(provider)) {
    return undefined
  }

  // Legacy callers can read quota before provider runtime initialization.
  // Load the service contribution only when needed; persisted-data loading remains independent.
  const { getBuiltinProviderModule } = await import(
    "~/services/providers/builtins"
  )
  return getBuiltinProviderModule(provider)?.fetchQuota?.(connection, signal)
}

/**
 * 将配额快照落到 connection(credential.quota + metadata.quotaState,
 * credential.status 随 setConnectionQuotaState 联动)。
 */
export function applyOAuthQuotaSnapshot(
  connection: ProviderConnection,
  snapshot: QuotaSnapshot,
): void {
  const previous = connection.credentials.at(0)?.quota
  if (previous && previous.fetchedAt > snapshot.fetchedAt) return
  if (snapshot.allowance) {
    snapshot.allowance = mergeQuotaAllowance(
      snapshot.allowance,
      previous?.allowance,
    )
  }
  setConnectionQuotaInfo(connection, snapshot)
  // Keep the plan reading beside the snapshot: a later refresh that fails
  // transiently replays this one instead of losing the last known allowance.
  noteSnapshotReading(connection, snapshot)

  // Legacy callers are accepted without guessing units or provider identity.
  const remaining =
    snapshot.premiumInteractionsRemaining ?? snapshot.chatRemaining
  let status =
    snapshot.allowance ? quotaAvailability(snapshot)
    : snapshot.unlimited ? "available"
    : remaining === undefined ? "unknown"
    : remaining <= 0 ? "exhausted"
    : "available"
  // Scoped capacity can lift an old account-wide lock; admission still checks
  // the requested model independently, including any other depleted pools.
  if (status === "unknown" && snapshot.allowance?.state === "known") {
    const models = snapshot.allowance.windows.flatMap(
      (window) => window.scope?.models ?? [],
    )
    if (
      models.some((model) => quotaAvailability(snapshot, model) === "available")
    )
      status = "available"
  }
  if (status === "unknown") return
  const exhausted = status === "exhausted"
  // Response events arrive on every turn, including from requests running
  // beside a fresh 429. Only a poll is evidence that a local wait has ended.
  if (!exhausted && snapshot.allowance?.partial) return
  setConnectionQuotaState(connection, exhausted ? "exhausted" : "available")
  if (exhausted && snapshot.allowance) {
    const resets = snapshot.allowance.windows
      .filter(
        (window) =>
          !window.aside
          && !window.scope
          && (window.remaining === 0 || (window.used ?? 0) >= 1),
      )
      .flatMap((window) =>
        window.resetsAtMs && window.resetsAtMs > Date.now() ?
          [window.resetsAtMs]
        : [],
      )
    if (resets.length) {
      const now = Date.now()
      // Bound the local retry wait, not the provider's actual quota window.
      const until = Math.max(
        now + 60_000,
        Math.min(now + 86_400_000, Math.max(...resets)),
      )
      for (const credential of connection.credentials) {
        if (credential.status === "quota_exhausted")
          credential.cooldownUntil = until
      }
    }
  }
  if (!exhausted) {
    // 配额恢复时同步清理内存限流器的残留冷却，否则即使 credential 已
    // 恢复为 ready，getRemainingCooldownSeconds 仍会报告旧的 24h 冷却，
    // 路由照样跳过该账号。credential 上持久化的 cooldownUntil 和 rest
    // 注册表由 liftRestAfterQuotaRecovery 一并解除。
    clearAccountPacingState(connection.id)
    liftRestAfterQuotaRecovery(connection)
  }
}
