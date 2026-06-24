import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { getOAuthProjectId, isOAuthAccount } from "~/lib/accounts"
import {
  ANTIGRAVITY_QUOTA_URLS,
  ANTIGRAVITY_REQUEST_HEADERS,
} from "~/lib/quota/constants"
import { enrichQuotaDetails } from "~/lib/quota/cycles"
import {
  parseAntigravityQuotaPayload,
  summarizeAntigravityQuota,
} from "~/lib/quota/parsers"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"

export async function fetchAntigravityQuota(
  account: Account,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (!isOAuthAccount(account) || account.provider !== "antigravity") {
    throw new Error(
      "fetchAntigravityQuota requires an Antigravity OAuth account",
    )
  }

  const projectId = getOAuthProjectId(account)
  if (!projectId) {
    throw new Error("Antigravity quota request requires project_id")
  }

  let lastError = "Antigravity quota request failed"
  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    const response = await executeUpstreamProxyCall(account, {
      method: "POST",
      url,
      headers: { ...ANTIGRAVITY_REQUEST_HEADERS },
      body: JSON.stringify({ project: projectId }),
      signal,
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      lastError = `Antigravity quota request failed (${response.statusCode}): ${response.body.slice(0, 200)}`
      continue
    }

    const payload = parseAntigravityQuotaPayload(response.body)
    if (!payload) {
      lastError = "Antigravity quota response was empty or invalid"
      continue
    }

    const summary = summarizeAntigravityQuota(payload)
    const remainingPercent =
      summary.remainingFraction !== undefined ?
        Math.round(summary.remainingFraction * 100)
      : undefined

    return {
      fetchedAt: Date.now(),
      provider: "antigravity" satisfies OAuthProviderId,
      unlimited: summary.unlimited,
      premiumInteractionsRemaining: remainingPercent,
      details: enrichQuotaDetails(
        "antigravity",
        payload as unknown as Record<string, unknown>,
      ),
    }
  }

  throw new Error(lastError)
}
