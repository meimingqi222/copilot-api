import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import type { QuotaAllowance, QuotaWindow } from "~/lib/quota/types"
import type { CodexUsagePayload, CodexRateLimitInfo } from "~/lib/quota/parsers"
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
import { asNumber } from "~/lib/json-shape"

export function codexAllowance(
  payload: CodexUsagePayload,
  now = Date.now(),
): QuotaAllowance {
  const windows: Array<QuotaWindow> = []
  const add = (
    id: string,
    info: CodexRateLimitInfo | null | undefined,
    aside = false,
  ) => {
    if (
      info?.allowed === false
      || info?.limit_reached === true
      || info?.limitReached === true
    ) {
      windows.push({
        id: `${id}-denied`,
        remaining: 0,
        unit: "requests",
        ...(aside ? { aside: true } : {}),
      })
    }
    for (const [key, window] of [
      ["primary", info?.primary_window ?? info?.primaryWindow],
      ["secondary", info?.secondary_window ?? info?.secondaryWindow],
    ] as const) {
      if (!window) continue
      const percent = asNumber(window.used_percent ?? window.usedPercent)
      const span = asNumber(
        window.limit_window_seconds ?? window.limitWindowSeconds,
      )
      const absolute = asNumber(window.reset_at ?? window.resetAt)
      const relative = asNumber(
        window.reset_after_seconds ?? window.resetAfterSeconds,
      )
      const reset =
        absolute !== undefined ? absolute * 1000
        : relative !== undefined ? now + relative * 1000
        : undefined
      windows.push({
        id: `${id}-${key}`,
        unit: "percent",
        ...(percent !== undefined ?
          { used: Math.max(0, Math.min(1, percent / 100)) }
        : {}),
        ...(span !== undefined && span > 0 ? { spanMs: span * 1000 } : {}),
        ...(reset !== undefined && Number.isFinite(reset) ?
          { resetsAtMs: reset }
        : {}),
        ...(aside ? { aside: true } : {}),
      })
    }
  }
  add("shared", payload.rate_limit ?? payload.rateLimit)
  add(
    "code-review",
    payload.code_review_rate_limit ?? payload.codeReviewRateLimit,
    true,
  )
  for (const [index, item] of (
    payload.additional_rate_limits
    ?? payload.additionalRateLimits
    ?? []
  ).entries()) {
    add(
      `additional-${item.metered_feature ?? item.meteredFeature ?? item.limit_name ?? item.limitName ?? index}`,
      item.rate_limit ?? item.rateLimit,
      true,
    )
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

export async function fetchCodexQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  if (getConnectionProvider(connection) !== "codex") {
    throw new Error("fetchCodexQuota requires a Codex OAuth connection")
  }

  const payload = await fetchCodexUsagePayload(connection, signal)
  const fetchedAt = Date.now()
  const resetCredits = await fetchCodexResetCredits(connection, signal)
  const summary = summarizeCodexQuota(payload)
  const meta = buildCodexQuotaMeta(connection, payload, resetCredits)

  return {
    fetchedAt,
    allowance: codexAllowance(payload, fetchedAt),
    provider: "codex" satisfies OAuthProviderId,
    unlimited: summary.unlimited,
    premiumInteractionsRemaining: summary.remainingPercent,
    details: enrichQuotaDetails("codex", {
      ...(payload as unknown as Record<string, unknown>),
      _codexMeta: meta,
    }),
  }
}
