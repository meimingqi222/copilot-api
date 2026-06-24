import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { isOAuthAccount } from "~/lib/accounts"
import { CLAUDE_REQUEST_HEADERS, CLAUDE_USAGE_URL } from "~/lib/quota/constants"
import { enrichQuotaDetails } from "~/lib/quota/cycles"
import {
  parseClaudeUsagePayload,
  summarizeClaudeQuota,
} from "~/lib/quota/parsers"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"

export async function fetchClaudeQuota(
  account: Account,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (!isOAuthAccount(account) || account.provider !== "claude") {
    throw new Error("fetchClaudeQuota requires a Claude OAuth account")
  }

  const response = await executeUpstreamProxyCall(account, {
    method: "GET",
    url: CLAUDE_USAGE_URL,
    headers: { ...CLAUDE_REQUEST_HEADERS },
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Claude quota request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }

  const payload = parseClaudeUsagePayload(response.body)
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
}
