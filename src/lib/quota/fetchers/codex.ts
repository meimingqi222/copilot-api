import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { isOAuthAccount } from "~/lib/accounts"
import {
  buildCodexQuotaMeta,
  fetchCodexResetCredits,
  fetchCodexUsagePayload,
} from "~/lib/quota/codex"
import { enrichQuotaDetails } from "~/lib/quota/cycles"
import { summarizeCodexQuota } from "~/lib/quota/parsers"

export async function fetchCodexQuota(
  account: Account,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (!isOAuthAccount(account) || account.provider !== "codex") {
    throw new Error("fetchCodexQuota requires a Codex OAuth account")
  }

  const payload = await fetchCodexUsagePayload(account, signal)
  const resetCredits = await fetchCodexResetCredits(account, signal)
  const summary = summarizeCodexQuota(payload)
  const meta = buildCodexQuotaMeta(account, payload, resetCredits)

  return {
    fetchedAt: Date.now(),
    provider: "codex" satisfies OAuthProviderId,
    unlimited: summary.unlimited,
    premiumInteractionsRemaining: summary.remainingPercent,
    details: enrichQuotaDetails("codex", {
      ...(payload as unknown as Record<string, unknown>),
      _codexMeta: meta,
    }),
  }
}
