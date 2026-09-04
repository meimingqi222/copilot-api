import type { QuotaSnapshot } from "~/lib/legacy-accounts"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import { CLAUDE_REQUEST_HEADERS, CLAUDE_USAGE_URL } from "~/lib/quota/constants"
import { enrichQuotaDetails } from "~/lib/quota/cycles"
import {
  fetchQuotaByDescriptor,
  type SimpleQuotaDescriptor,
} from "~/lib/quota/fetch-engine"
import {
  parseClaudeUsagePayload,
  summarizeClaudeQuota,
} from "~/lib/quota/parsers"

const claudeQuotaDescriptor: SimpleQuotaDescriptor = {
  provider: "claude",
  displayName: "Claude",
  url: CLAUDE_USAGE_URL,
  headers: { ...CLAUDE_REQUEST_HEADERS },
  buildSnapshot(body, _connection): QuotaSnapshot {
    const payload = parseClaudeUsagePayload(body)
    if (!payload) {
      throw new Error("Claude quota response was empty or invalid")
    }

    const summary = summarizeClaudeQuota(payload)
    const remainingPercent =
      summary.remainingFraction !== undefined ?
        Math.round(summary.remainingFraction * 100)
      : undefined

    return {
      fetchedAt: Date.now(),
      provider: "claude" satisfies OAuthProviderId,
      unlimited: summary.unlimited,
      premiumInteractionsRemaining: remainingPercent,
      details: enrichQuotaDetails(
        "claude",
        payload as unknown as Record<string, unknown>,
      ),
    }
  },
}

export async function fetchClaudeQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  return fetchQuotaByDescriptor(connection, claudeQuotaDescriptor, signal)
}
