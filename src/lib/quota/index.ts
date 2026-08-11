import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { setAccountQuotaState } from "~/lib/account-availability"
import { isOAuthAccount } from "~/lib/accounts"

import { fetchAntigravityQuota } from "./fetchers/antigravity"
import { fetchClaudeQuota } from "./fetchers/claude"
import { fetchCodexQuota } from "./fetchers/codex"
import { fetchKimiQuota } from "./fetchers/kimi"
import { fetchXaiQuota } from "./fetchers/xai"

const PERCENTAGE_QUOTA_EXHAUSTION_THRESHOLD = 0
const COUNT_QUOTA_EXHAUSTION_THRESHOLD = 5

const QUOTA_FETCHERS: Record<
  OAuthProviderId,
  (account: Account, signal?: AbortSignal) => Promise<QuotaSnapshot>
> = {
  antigravity: fetchAntigravityQuota,
  claude: fetchClaudeQuota,
  kimi: fetchKimiQuota,
  codex: fetchCodexQuota,
  xai: fetchXaiQuota,
}

export async function fetchOAuthProviderQuota(
  account: Account,
  signal?: AbortSignal,
): Promise<QuotaSnapshot | undefined> {
  if (!isOAuthAccount(account)) {
    return undefined
  }

  return QUOTA_FETCHERS[account.provider](account, signal)
}

export function applyOAuthQuotaSnapshot(
  account: Account,
  snapshot: QuotaSnapshot,
): void {
  account.quotaInfo = snapshot

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

  setAccountQuotaState(account, exhausted ? "exhausted" : "available")
}
