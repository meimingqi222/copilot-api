import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import type { QuotaWindow } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { GITHUB_API_BASE_URL, githubApiHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { getConnectionProvider } from "~/lib/provider-connections"

interface CopilotQuotaProduct {
  remaining: number
  entitlement: number
  unlimited: boolean
  percent_remaining?: number
  overage_permitted?: boolean
  has_quota?: boolean
}

interface CopilotUsageResponse {
  copilot_plan?: string
  quota_reset_date_utc?: string
  quota_reset_date?: string
  quota_snapshots?: {
    premium_interactions?: CopilotQuotaProduct
    chat?: CopilotQuotaProduct
    completions?: CopilotQuotaProduct
  }
}

/**
 * Copilot 订阅配额快照（非 OAuth：用 credential.context.githubToken 走
 * GitHub 内部接口），与 lib/quota/fetchers 下其它 provider 同形。
 */
export async function fetchCopilotQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  if (getConnectionProvider(connection) !== "copilot") {
    throw new Error("fetchCopilotQuota requires a Copilot connection")
  }

  const githubToken = readConnectionGithubToken(connection)
  if (!githubToken) {
    throw new Error(`GitHub token missing for connection "${connection.name}"`)
  }

  const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    signal,
    headers: {
      ...githubApiHeaders(),
      authorization: `token ${githubToken}`,
    },
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot usage", response)
  }

  return snapshotFromCopilotUsage(
    (await response.json()) as CopilotUsageResponse,
    connection,
  )
}

function readConnectionGithubToken(
  connection: ProviderConnection,
): string | undefined {
  const token = connection.credentials[0]?.context?.githubToken
  return typeof token === "string" && token ? token : undefined
}

export function snapshotFromCopilotUsage(
  usage: CopilotUsageResponse,
  connection: ProviderConnection,
): ProviderQuotaSnapshot {
  const snapshots = usage.quota_snapshots ?? {}
  const premium = snapshots.premium_interactions
  const chat = snapshots.chat
  const completions = snapshots.completions

  const unlimited = Boolean(
    premium?.unlimited || chat?.unlimited || completions?.unlimited,
  )
  // Organization seats are paused by the org whatever `overage_permitted` says.
  const managed = /^(business|enterprise)$/i.test(usage.copilot_plan ?? "")
  const resetsAtMs = Date.parse(
    usage.quota_reset_date_utc ?? usage.quota_reset_date ?? "",
  )
  const windows: Array<QuotaWindow> = []
  for (const [id, product] of [
    ["premium-interactions", premium],
    ["chat", chat],
    ["completions", completions],
  ] as const) {
    if (!product) continue
    // A pooled "unlimited" premium product without quota is spent.
    const pooledOut =
      id === "premium-interactions"
      && product.unlimited === true
      && product.has_quota === false
    const total =
      Number.isFinite(product.entitlement) ? product.entitlement : undefined
    const remaining =
      pooledOut ? 0
      : Number.isFinite(product.remaining) ? product.remaining
      : undefined
    const used =
      pooledOut ? 1
      : product.unlimited ? undefined
      : total !== undefined && total > 0 && remaining !== undefined ?
        Math.max(0, Math.min(1, 1 - remaining / total))
      : Number.isFinite(product.percent_remaining) ?
        Math.max(0, Math.min(1, 1 - product.percent_remaining! / 100))
      : undefined
    windows.push({
      id,
      total,
      remaining,
      unit: "requests",
      unlimited: product.unlimited === true && !pooledOut,
      ...(used !== undefined && { used }),
      ...(Number.isFinite(resetsAtMs) && !product.unlimited && { resetsAtMs }),
      ...(id === "chat" ?
        {
          scope: {
            models: [
              ...new Set(
                (connection.models ?? [])
                  .filter((model) =>
                    model.endpoints.some((endpoint) =>
                      ["chat", "messages", "responses", "gemini"].includes(
                        endpoint,
                      ),
                    ),
                  )
                  .map((model) => model.upstreamId),
              ),
            ],
          },
        }
        // Premium requests limit the whole account (as in magpie): the catalog
        // cannot say which models are premium. Paid overage on a personal plan
        // keeps it serving; completions never stop chat traffic.
      : (
        id === "completions" || (product.overage_permitted === true && !managed)
      ) ?
        { aside: true }
      : {}),
    })
  }

  return {
    fetchedAt: Date.now(),
    allowance: {
      state:
        (
          windows.some(
            (window) => window.remaining !== undefined || window.unlimited,
          )
        ) ?
          "known"
        : "unknown",
      windows,
    },
    premiumInteractionsRemaining: premium?.remaining,
    premiumInteractionsTotal: premium?.entitlement,
    chatRemaining: chat?.remaining,
    chatTotal: chat?.entitlement,
    completionsRemaining: completions?.remaining,
    completionsTotal: completions?.entitlement,
    unlimited,
  }
}
