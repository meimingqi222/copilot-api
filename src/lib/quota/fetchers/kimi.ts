import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { isOAuthAccount } from "~/lib/accounts"
import { KIMI_REQUEST_HEADERS, KIMI_USAGE_URL } from "~/lib/quota/constants"
import { enrichQuotaDetails } from "~/lib/quota/cycles"
import { parseKimiUsagePayload, summarizeKimiQuota } from "~/lib/quota/parsers"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"

export async function fetchKimiQuota(
  account: Account,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (!isOAuthAccount(account) || account.provider !== "kimi") {
    throw new Error("fetchKimiQuota requires a Kimi OAuth account")
  }

  const response = await executeUpstreamProxyCall(account, {
    method: "GET",
    url: KIMI_USAGE_URL,
    headers: { ...KIMI_REQUEST_HEADERS },
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Kimi quota request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }

  const payload = parseKimiUsagePayload(response.body)
  if (!payload) {
    throw new Error("Kimi quota response was empty or invalid")
  }

  const summary = summarizeKimiQuota(payload)

  return {
    fetchedAt: Date.now(),
    provider: "kimi" satisfies OAuthProviderId,
    unlimited: summary.unlimited,
    chatRemaining: summary.remaining,
    chatTotal: summary.total,
    details: enrichQuotaDetails(
      "kimi",
      payload as unknown as Record<string, unknown>,
    ),
  }
}
