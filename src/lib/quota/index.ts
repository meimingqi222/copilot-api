import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { setAccountQuotaState } from "~/lib/account-availability"
import { isOAuthAccount } from "~/lib/accounts"

import { fetchAntigravityQuota } from "./fetchers/antigravity"
import { fetchClaudeQuota } from "./fetchers/claude"
import { fetchCodexQuota } from "./fetchers/codex"
import { fetchKimiQuota } from "./fetchers/kimi"
import { fetchXaiQuota } from "./fetchers/xai"

const QUOTA_EXHAUSTION_THRESHOLD = 5

export async function fetchOAuthProviderQuota(
  account: Account,
  signal?: AbortSignal,
): Promise<QuotaSnapshot | undefined> {
  if (!isOAuthAccount(account)) {
    return undefined
  }

  switch (account.provider) {
    case "antigravity": {
      return fetchAntigravityQuota(account, signal)
    }
    case "claude": {
      return fetchClaudeQuota(account, signal)
    }
    case "kimi": {
      return fetchKimiQuota(account, signal)
    }
    case "codex": {
      return fetchCodexQuota(account, signal)
    }
    case "xai": {
      return fetchXaiQuota(account, signal)
    }
    default: {
      return undefined
    }
  }
}

export function applyOAuthQuotaSnapshot(
  account: Account,
  snapshot: QuotaSnapshot,
): void {
  account.quotaInfo = snapshot

  const provider = snapshot.provider as OAuthProviderId | undefined
  const remaining =
    snapshot.premiumInteractionsRemaining
    ?? snapshot.chatRemaining
    ?? (snapshot.unlimited ? Infinity : undefined)

  const exhausted =
    !snapshot.unlimited
    && remaining !== undefined
    && remaining <= QUOTA_EXHAUSTION_THRESHOLD

  setAccountQuotaState(account, exhausted ? "exhausted" : "available")
  void provider
}
