import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { GITHUB_API_BASE_URL, githubApiHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { getConnectionProvider } from "~/lib/provider-connections"

interface CopilotUsageResponse {
  quota_snapshots?: {
    premium_interactions?: {
      remaining: number
      entitlement: number
      unlimited: boolean
    }
    chat?: { remaining: number; entitlement: number; unlimited: boolean }
    completions?: { remaining: number; entitlement: number; unlimited: boolean }
  }
}

/**
 * Copilot 订阅配额快照（非 OAuth：用 credential.context.githubToken 走
 * GitHub 内部接口），与 lib/quota/fetchers 下其它 provider 同形。
 */
export async function fetchCopilotQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
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

  return snapshotFromUsage((await response.json()) as CopilotUsageResponse)
}

function readConnectionGithubToken(
  connection: ProviderConnection,
): string | undefined {
  const token = connection.credentials[0]?.context?.githubToken
  return typeof token === "string" && token ? token : undefined
}

function snapshotFromUsage(usage: CopilotUsageResponse): QuotaSnapshot {
  const snapshots = usage.quota_snapshots ?? {}
  const premium = snapshots.premium_interactions
  const chat = snapshots.chat
  const completions = snapshots.completions

  const unlimited = Boolean(
    premium?.unlimited || chat?.unlimited || completions?.unlimited,
  )

  return {
    fetchedAt: Date.now(),
    premiumInteractionsRemaining: premium?.remaining,
    premiumInteractionsTotal: premium?.entitlement,
    chatRemaining: chat?.remaining,
    chatTotal: chat?.entitlement,
    completionsRemaining: completions?.remaining,
    completionsTotal: completions?.entitlement,
    unlimited,
  }
}
