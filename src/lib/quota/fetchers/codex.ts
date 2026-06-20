import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { getOAuthAccountId, isOAuthAccount } from "~/lib/accounts"
import { CODEX_REQUEST_HEADERS, CODEX_USAGE_URL } from "~/lib/quota/constants"
import {
  parseCodexUsagePayload,
  summarizeCodexQuota,
} from "~/lib/quota/parsers"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"

export async function fetchCodexQuota(
  account: Account,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (!isOAuthAccount(account) || account.provider !== "codex") {
    throw new Error("fetchCodexQuota requires a Codex OAuth account")
  }

  const headers: Record<string, string> = { ...CODEX_REQUEST_HEADERS }
  const accountId = getOAuthAccountId(account)
  if (accountId) {
    headers["Chatgpt-Account-Id"] = accountId
  }

  const response = await executeUpstreamProxyCall(account, {
    method: "GET",
    url: CODEX_USAGE_URL,
    headers,
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Codex quota request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }

  const payload = parseCodexUsagePayload(response.body)
  if (!payload) {
    throw new Error("Codex quota response was empty or invalid")
  }

  const summary = summarizeCodexQuota(payload)

  return {
    fetchedAt: Date.now(),
    provider: "codex" satisfies OAuthProviderId,
    unlimited: summary.unlimited,
    premiumInteractionsRemaining: summary.remainingPercent,
    details: payload as unknown as Record<string, unknown>,
  }
}
