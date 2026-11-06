import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import type { QuotaAllowance, QuotaWindow } from "~/lib/quota/types"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"
import type { XaiBillingPayload } from "~/lib/quota/parsers"

import { getConnectionProvider } from "~/lib/provider-connections"
import { XAI_BILLING_URL, XAI_REQUEST_HEADERS } from "~/lib/quota/constants"
import { parseXaiBillingPayload, summarizeXaiQuota } from "~/lib/quota/parsers"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import { asNumber } from "~/lib/json-shape"

export function xaiAllowance(payload: XaiBillingPayload): QuotaAllowance {
  const config = payload.config
  const windows: Array<QuotaWindow> = []
  if (!config) return { state: "unknown", windows }
  const percent = asNumber(
    config.creditUsagePercent ?? config.credit_usage_percent,
  )
  const period = config.currentPeriod ?? config.current_period
  const hasCreditPeriod = percent !== undefined || period != null
  const reset = Date.parse(
    period?.end ?? config.billingPeriodEnd ?? config.billing_period_end ?? "",
  )
  const start = Date.parse(
    period?.start
      ?? config.billingPeriodStart
      ?? config.billing_period_start
      ?? "",
  )
  const span =
    Number.isFinite(reset) && Number.isFinite(start) && reset > start ?
      reset - start
    : ["weekly", "USAGE_PERIOD_TYPE_WEEKLY"].includes(period?.type ?? "") ?
      604_800_000
    : undefined
  if (hasCreditPeriod) {
    windows.push({
      id: "credit-period",
      unit: "percent",
      ...(span !== undefined ? { spanMs: span } : {}),
      ...(percent !== undefined ?
        { used: Math.max(0, Math.min(1, percent / 100)) }
      : {}),
      ...(Number.isFinite(reset) ? { resetsAtMs: reset } : {}),
    })
  }
  const summary = summarizeXaiQuota(payload)
  const monthlyReset = Date.parse(
    config.monthlyBillingPeriodEnd
      ?? config.monthly_billing_period_end
      ?? (!hasCreditPeriod ?
        (config.billingPeriodEnd ?? config.billing_period_end)
      : undefined)
      ?? "",
  )
  const monthlyConstraint =
    summary.totalCents !== undefined
    && summary.totalCents > 0
    && summary.remainingCents !== undefined
  if (
    summary.totalCents !== undefined
    || summary.remainingCents !== undefined
  ) {
    windows.push({
      id: "monthly-spend",
      unit: "currency",
      total: summary.totalCents,
      remaining: summary.remainingCents,
      ...((
        summary.totalCents !== undefined
        && summary.totalCents > 0
        && summary.remainingCents !== undefined
      ) ?
        {
          used: Math.max(
            0,
            Math.min(1, 1 - summary.remainingCents / summary.totalCents),
          ),
        }
      : {}),
      ...(Number.isFinite(monthlyReset) ? { resetsAtMs: monthlyReset } : {}),
      // A positive measured cap constrains usage; zero/unknown caps do not deny credits.
      ...(!monthlyConstraint ? { aside: true } : {}),
    })
  }
  return {
    state:
      (
        windows.some(
          (window) =>
            window.used !== undefined || window.remaining !== undefined,
        )
      ) ?
        "known"
      : "unknown",
    windows,
  }
}

export async function fetchXaiQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  if (getConnectionProvider(connection) !== "xai") {
    throw new Error("fetchXaiQuota requires an xAI OAuth connection")
  }

  const baseResponse = await executeUpstreamProxyCall(connection, {
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
    const creditsResponse = await executeUpstreamProxyCall(connection, {
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
    allowance: xaiAllowance(payload),
    provider: "xai" satisfies OAuthProviderId,
    unlimited: summary.unlimited,
    premiumInteractionsRemaining: summary.remainingPercent,
    chatRemaining: summary.remainingCents,
    chatTotal: summary.totalCents,
    details: payload as unknown as Record<string, unknown>,
  }
}
