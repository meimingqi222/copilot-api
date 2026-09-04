import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import { isOAuthProviderId } from "~/lib/provider-config"
import {
  getConnectionProvider,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"

import { fetchAntigravityQuota } from "./fetchers/antigravity"
import { fetchClaudeQuota } from "./fetchers/claude"
import { fetchCodexQuota } from "./fetchers/codex"
import { fetchKimiQuota } from "./fetchers/kimi"
import { fetchXaiQuota } from "./fetchers/xai"

const PERCENTAGE_QUOTA_EXHAUSTION_THRESHOLD = 0
const COUNT_QUOTA_EXHAUSTION_THRESHOLD = 5

const QUOTA_FETCHERS: Record<
  OAuthProviderId,
  (
    connection: ProviderConnection,
    signal?: AbortSignal,
  ) => Promise<QuotaSnapshot>
> = {
  antigravity: fetchAntigravityQuota,
  claude: fetchClaudeQuota,
  kimi: fetchKimiQuota,
  codex: fetchCodexQuota,
  xai: fetchXaiQuota,
}

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

  return QUOTA_FETCHERS[provider](connection, signal)
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
}
