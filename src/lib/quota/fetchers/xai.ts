import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { isOAuthAccount } from "~/lib/accounts"
import { XAI_BILLING_URL, XAI_REQUEST_HEADERS } from "~/lib/quota/constants"
import { parseXaiBillingPayload, summarizeXaiQuota } from "~/lib/quota/parsers"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"

export async function fetchXaiQuota(
  account: Account,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (!isOAuthAccount(account) || account.provider !== "xai") {
    throw new Error("fetchXaiQuota requires an xAI OAuth account")
  }

  const response = await executeUpstreamProxyCall(account, {
    method: "GET",
    url: XAI_BILLING_URL,
    headers: { ...XAI_REQUEST_HEADERS },
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `xAI quota request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }

  const payload = parseXaiBillingPayload(response.body)
  if (!payload) {
    throw new Error("xAI quota response was empty or invalid")
  }

  const summary = summarizeXaiQuota(payload)

  return {
    fetchedAt: Date.now(),
    provider: "xai" satisfies OAuthProviderId,
    unlimited: summary.unlimited,
    premiumInteractionsRemaining: summary.remainingPercent,
    chatRemaining: summary.remainingCents,
    chatTotal: summary.totalCents,
    details: payload as unknown as Record<string, unknown>,
  }
}
