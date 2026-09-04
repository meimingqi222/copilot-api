import type { QuotaSnapshot } from "~/lib/legacy-accounts"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import { KIMI_REQUEST_HEADERS, KIMI_USAGE_URL } from "~/lib/quota/constants"
import { enrichQuotaDetails } from "~/lib/quota/cycles"
import {
  fetchQuotaByDescriptor,
  type SimpleQuotaDescriptor,
} from "~/lib/quota/fetch-engine"
import { parseKimiUsagePayload, summarizeKimiQuota } from "~/lib/quota/parsers"

const kimiQuotaDescriptor: SimpleQuotaDescriptor = {
  provider: "kimi",
  displayName: "Kimi",
  url: KIMI_USAGE_URL,
  headers: { ...KIMI_REQUEST_HEADERS },
  buildSnapshot(body, _connection): QuotaSnapshot {
    const payload = parseKimiUsagePayload(body)
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
  },
}

export async function fetchKimiQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  return fetchQuotaByDescriptor(connection, kimiQuotaDescriptor, signal)
}
