import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import type { QuotaAllowance, QuotaWindow } from "~/lib/quota/types"
import type { KimiUsagePayload } from "~/lib/quota/parsers"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import { KIMI_REQUEST_HEADERS, KIMI_USAGE_URL } from "~/lib/quota/constants"
import { enrichQuotaDetails } from "~/lib/quota/cycles"
import {
  fetchQuotaByDescriptor,
  type SimpleQuotaDescriptor,
} from "~/lib/quota/fetch-engine"
import { parseKimiUsagePayload, summarizeKimiQuota } from "~/lib/quota/parsers"
import { asNumber } from "~/lib/json-shape"

export function kimiAllowance(
  payload: KimiUsagePayload,
  now = Date.now(),
): QuotaAllowance {
  const windows: Array<QuotaWindow> = []
  const candidates = [
    ...(payload.usage ?
      [{ id: "summary", data: payload.usage as Record<string, unknown> }]
    : []),
    ...(payload.limits ?? []).map((item, index) => ({
      id: `limit-${item.name ?? index}`,
      data: { ...(item.detail ?? item), ...item.window } as Record<
        string,
        unknown
      >,
    })),
  ]
  for (const { id, data } of candidates) {
    const total = asNumber(data.limit)
    const consumed = asNumber(data.used)
    const remaining =
      asNumber(data.remaining)
      ?? (total !== undefined && consumed !== undefined ?
        Math.max(0, total - consumed)
      : undefined)
    const used =
      total !== undefined && total > 0 ?
        consumed !== undefined ? consumed / total
        : remaining !== undefined ? 1 - remaining / total
        : undefined
      : undefined
    const absolute =
      data.reset_at ?? data.resetAt ?? data.reset_time ?? data.resetTime
    const parsed = typeof absolute === "string" ? Date.parse(absolute) : NaN
    const relative = asNumber(data.reset_in ?? data.resetIn ?? data.ttl)
    const reset =
      Number.isFinite(parsed) ? parsed
      : relative !== undefined && relative >= 0 ? now + relative * 1000
      : undefined
    const duration = asNumber(data.duration)
    const multiplier = {
      SECONDS: 1000,
      MINUTES: 60_000,
      HOURS: 3_600_000,
      DAYS: 86_400_000,
    }[String(data.timeUnit).toUpperCase()]
    windows.push({
      id,
      unit: "units",
      remaining,
      total,
      ...(used !== undefined ? { used: Math.max(0, Math.min(1, used)) } : {}),
      ...(reset !== undefined ? { resetsAtMs: reset } : {}),
      ...(duration !== undefined && duration > 0 && multiplier ?
        { spanMs: duration * multiplier }
      : {}),
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

const kimiQuotaDescriptor: SimpleQuotaDescriptor = {
  provider: "kimi",
  displayName: "Kimi",
  url: KIMI_USAGE_URL,
  headers: { ...KIMI_REQUEST_HEADERS },
  buildSnapshot(body, _connection): ProviderQuotaSnapshot {
    const payload = parseKimiUsagePayload(body)
    if (!payload) {
      throw new Error("Kimi quota response was empty or invalid")
    }

    const summary = summarizeKimiQuota(payload)
    const fetchedAt = Date.now()

    return {
      fetchedAt,
      allowance: kimiAllowance(payload, fetchedAt),
      provider: "kimi" satisfies OAuthProviderId,
      unlimited: summary.unlimited,
      chatRemaining: summary.remaining,
      chatTotal: summary.total,
      details: enrichQuotaDetails(
        "kimi",
        payload as unknown as Record<string, unknown>,
      ),
    }
  },
}

export async function fetchKimiQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  return fetchQuotaByDescriptor(connection, kimiQuotaDescriptor, signal)
}
