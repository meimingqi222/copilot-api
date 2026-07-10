import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { XaiBillingPayload } from "~/lib/quota/parsers"

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

  const baseResponse = await executeUpstreamProxyCall(account, {
    method: "GET",
    url: XAI_BILLING_URL,
    headers: { ...XAI_REQUEST_HEADERS },
    signal,
  })

  if (baseResponse.statusCode < 200 || baseResponse.statusCode >= 300) {
    throw new Error(
      `xAI quota request failed (${baseResponse.statusCode}): ${baseResponse.body.slice(0, 200)}`,
    )
  }

  const basePayload = parseXaiBillingPayload(baseResponse.body)
  if (!basePayload) {
    throw new Error("xAI quota response was empty or invalid")
  }

  let creditsPayload: XaiBillingPayload | null = null
  try {
    const creditsResponse = await executeUpstreamProxyCall(account, {
      method: "GET",
      url: `${XAI_BILLING_URL}?format=credits`,
      headers: { ...XAI_REQUEST_HEADERS },
      signal,
    })
    if (creditsResponse.statusCode >= 200 && creditsResponse.statusCode < 300) {
      creditsPayload = parseXaiBillingPayload(creditsResponse.body)
    }
  } catch {
    // Ignore the credits-format request; the base response is enough.
  }

  const baseConfig = basePayload.config
  const creditsConfig = creditsPayload?.config

  const mergedConfig = {
    ...baseConfig,
    ...creditsConfig,
    // Preserve the base (monthly) billing period before the credits (weekly)
    // payload overwrites it.
    ...(baseConfig?.billingPeriodEnd && {
      monthlyBillingPeriodEnd: baseConfig.billingPeriodEnd,
    }),
    ...(baseConfig?.billing_period_end && {
      monthly_billing_period_end: baseConfig.billing_period_end,
    }),
    ...(baseConfig?.billingPeriodStart && {
      monthlyBillingPeriodStart: baseConfig.billingPeriodStart,
    }),
    ...(baseConfig?.billing_period_start && {
      monthly_billing_period_start: baseConfig.billing_period_start,
    }),
  }

  const payload: XaiBillingPayload = {
    ...basePayload,
    config: mergedConfig,
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
