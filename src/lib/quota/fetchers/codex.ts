import type { QuotaSnapshot } from "~/lib/legacy-accounts"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import {
  buildCodexQuotaMeta,
  fetchCodexResetCredits,
  fetchCodexUsagePayload,
} from "~/lib/quota/codex"
import { enrichQuotaDetails } from "~/lib/quota/cycles"
import { summarizeCodexQuota } from "~/lib/quota/parsers"

export async function fetchCodexQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "codex") {
    throw new Error("fetchCodexQuota requires a Codex OAuth connection")
  }

  const payload = await fetchCodexUsagePayload(connection, signal)
  const resetCredits = await fetchCodexResetCredits(connection, signal)
  const summary = summarizeCodexQuota(payload)
  const meta = buildCodexQuotaMeta(connection, payload, resetCredits)

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
