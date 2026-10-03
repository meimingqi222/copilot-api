import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import { noteSnapshotReading } from "~/lib/plan-quota/apply"
import { isOAuthProviderId } from "~/lib/provider-config"
import {
  getConnectionProvider,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import { clearAccountRateLimitState } from "~/lib/rate-limit"

const PERCENTAGE_QUOTA_EXHAUSTION_THRESHOLD = 0
const COUNT_QUOTA_EXHAUSTION_THRESHOLD = 5

/**
 * 拉取 OAuth provider 配额快照(connection 原生)。
 * 刷新材料与 access token 均从 connection credential 读取;
 * 非 OAuth connection 返回 undefined。
 */
export async function fetchOAuthProviderQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot | undefined> {
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
 * 将配额快照落到 connection(metadata.quotaInfo + quotaState,
 * credential.status 随 setConnectionQuotaState 联动)。
 */
export function applyOAuthQuotaSnapshot(
  connection: ProviderConnection,
  snapshot: QuotaSnapshot,
): void {
  setConnectionQuotaInfo(connection, snapshot)
  // Keep the plan reading beside the snapshot: a later refresh that fails
  // transiently replays this one instead of losing the last known allowance.
  noteSnapshotReading(connection, snapshot)

  const provider = snapshot.provider as OAuthProviderId | undefined

  // xAI's `chatRemaining` is monthly credit *cents*, not a message count, so
  // the count threshold must not mark it exhausted when the user has no monthly
  // limit (e.g. Grok CLI weekly-credit accounts). Exhaustion for xAI is
  // already handled by the percentage threshold (weekly/credit usage percent).
  const countExhausted =
    provider !== "xai"
    && snapshot.chatRemaining !== undefined
    && snapshot.chatRemaining <= COUNT_QUOTA_EXHAUSTION_THRESHOLD

  const exhausted =
    !snapshot.unlimited
    && ((snapshot.premiumInteractionsRemaining !== undefined
      && snapshot.premiumInteractionsRemaining
        <= PERCENTAGE_QUOTA_EXHAUSTION_THRESHOLD)
      || countExhausted)

  setConnectionQuotaState(connection, exhausted ? "exhausted" : "available")
  if (!exhausted) {
    // 配额恢复时同步清理内存限流器的残留冷却，否则即使 credential 已
    // 恢复为 ready，getRemainingCooldownSeconds 仍会报告旧的 24h 冷却，
    // 路由照样跳过该账号。
    clearAccountRateLimitState(connection.id)
  }
}
