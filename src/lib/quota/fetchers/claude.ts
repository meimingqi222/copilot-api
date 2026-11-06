import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import type { QuotaAllowance, QuotaWindow } from "~/lib/quota/types"
import type { ClaudeUsagePayload } from "~/lib/quota/parsers"
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
  buildSnapshot(body, connection): ProviderQuotaSnapshot {
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
      allowance: claudeAllowance(payload, connection),
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

/** Family meters constrain only exact native IDs discovered on this connection. */
export function claudeAllowance(
  payload: ClaudeUsagePayload,
  connection: ProviderConnection,
): QuotaAllowance {
  const windows: Array<QuotaWindow> = []
  for (const key of [
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_oauth_apps",
    "seven_day_cowork",
    "iguana_necktie",
  ] as const) {
    const value = payload[key]
    if (!value) continue
    const used =
      (
        typeof value.utilization === "number"
        && Number.isFinite(value.utilization)
      ) ?
        Math.max(0, Math.min(1, value.utilization))
      : undefined
    const reset =
      typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN
    const family =
      key === "seven_day_opus" ? "opus"
      : key === "seven_day_sonnet" ? "sonnet"
      : undefined
    const aside = !family && key !== "five_hour" && key !== "seven_day"
    windows.push({
      id: key,
      used,
      unit: "percent",
      spanMs:
        key === "five_hour" ? 18_000_000
        : key.startsWith("seven_day") ? 604_800_000
        : undefined,
      ...(Number.isFinite(reset) ? { resetsAtMs: reset } : {}),
      ...(family ?
        {
          scope: {
            models: [
              ...new Set(
                (connection.models ?? [])
                  .map((model) => model.upstreamId)
                  .filter((id) =>
                    new RegExp(
                      `^claude-(?:\\d+(?:[.-]\\d+)*-)?${family}(?:[-.:]|$)`,
                      "i",
                    ).test(id),
                  ),
              ),
            ],
          },
        }
      : {}),
      ...(aside ? { aside: true } : {}),
    })
  }
  return {
    state:
      windows.some((window) => window.used !== undefined) ? "known" : "unknown",
    windows,
  }
}

export async function fetchClaudeQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  return fetchQuotaByDescriptor(connection, claudeQuotaDescriptor, signal)
}
