import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import type { QuotaAllowance, QuotaWindow } from "~/lib/quota/types"
import type { AntigravityQuotaSummaryPayload } from "~/lib/quota/parsers"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  getConnectionProvider,
  getCredentialContextString,
} from "~/lib/provider-connections"
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
import { asNumber } from "~/lib/json-shape"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { requestAntigravityAvailableModels } from "~/services/antigravity/get-models"

interface AntigravityModelQuotaNode {
  quotaInfo?: { remainingFraction?: unknown; resetTime?: unknown } | null
}

function fractionOf(raw: unknown): number | undefined {
  const percent = typeof raw === "string" && raw.trim().endsWith("%")
  const value = asNumber(percent ? (raw as string).trim().slice(0, -1) : raw)
  return (
    value === undefined ? undefined
    : percent ? value / 100
    : value
  )
}

function resetOf(raw: unknown): number | undefined {
  const reset = typeof raw === "string" ? Date.parse(raw) : NaN
  return Number.isFinite(reset) ? reset : undefined
}

/**
 * Routing follows each model's own `fetchAvailableModels.quotaInfo`, as magpie
 * does: a summary bucket id (`gemini-5h`, `3p-weekly`, …) is not a contract
 * linking a pool to models, so summary buckets are reporting-only. Antigravity
 * leaves `remainingFraction` out once none is left (proto3 drops zero).
 */
export function antigravityAllowance(
  modelsBody: string | undefined,
  summary: AntigravityQuotaSummaryPayload | undefined,
): QuotaAllowance {
  const windows: Array<QuotaWindow> = []
  let models: Record<string, AntigravityModelQuotaNode> = {}
  try {
    const parsed = modelsBody ? (JSON.parse(modelsBody) as unknown) : undefined
    const record =
      parsed && typeof parsed === "object" ?
        (parsed as { models?: unknown }).models
      : undefined
    if (record && typeof record === "object")
      models = record as Record<string, AntigravityModelQuotaNode>
  } catch {
    models = {}
  }
  for (const [rawId, node] of Object.entries(models)) {
    const quota = node?.quotaInfo
    // No quotaInfo at all says nothing; an empty one means none is left.
    if (!quota || typeof quota !== "object") continue
    const remaining = fractionOf(quota.remainingFraction) ?? 0
    const resetsAtMs = resetOf(quota.resetTime)
    const id = rawId.trim()
    windows.push({
      id: `model:${id}`,
      unit: "percent",
      used: Math.max(0, Math.min(1, 1 - remaining)),
      ...(resetsAtMs !== undefined && { resetsAtMs }),
      scope: { models: [...new Set([id, canonicalNativeModelId(id)])] },
    })
  }
  for (const [groupIndex, group] of (summary?.groups ?? []).entries()) {
    for (const [index, bucket] of (group.buckets ?? []).entries()) {
      const id = bucket.bucketId || bucket.bucket_id
      const fraction =
        fractionOf(bucket.remainingFraction ?? bucket.remaining_fraction) ?? 0
      const resetsAtMs = resetOf(bucket.resetTime ?? bucket.reset_time)
      windows.push({
        id: `${group.displayName || group.display_name || groupIndex}-${id || bucket.window || index}`,
        unit: "percent",
        used: Math.max(0, Math.min(1, 1 - fraction)),
        ...(resetsAtMs !== undefined && { resetsAtMs }),
        aside: true,
      })
    }
  }
  return {
    state: windows.some((window) => !window.aside) ? "known" : "unknown",
    windows,
  }
}

export async function fetchAntigravityQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  if (getConnectionProvider(connection) !== "antigravity") {
    throw new Error(
      "fetchAntigravityQuota requires an Antigravity OAuth connection",
    )
  }

  const projectId = readConnectionProjectId(connection)
  if (!projectId) {
    throw new Error("Antigravity quota request requires project_id")
  }

  // Either reply is useful alone: models drive routing, the summary the card.
  const [models, summary] = await Promise.allSettled([
    requestAntigravityAvailableModels(connection, signal),
    fetchAntigravityQuotaSummary(connection, projectId, signal),
  ])
  const modelsBody = models.status === "fulfilled" ? models.value : undefined
  const payload = summary.status === "fulfilled" ? summary.value : undefined
  if (modelsBody === undefined && payload === undefined) {
    throw (
      summary.status === "rejected" ? summary.reason
      : models.status === "rejected" ? models.reason
      : new Error("Antigravity quota response was empty or invalid")
    )
  }

  const summarized = payload ? summarizeAntigravityQuota(payload) : undefined
  const remainingPercent =
    summarized?.remainingFraction !== undefined ?
      Math.round(summarized.remainingFraction * 100)
    : undefined

  return {
    fetchedAt: Date.now(),
    allowance: antigravityAllowance(modelsBody, payload),
    provider: "antigravity" satisfies OAuthProviderId,
    unlimited: summarized?.unlimited ?? false,
    premiumInteractionsRemaining: remainingPercent,
    details: enrichQuotaDetails(
      "antigravity",
      (payload ?? {}) as unknown as Record<string, unknown>,
    ),
  }
}

async function fetchAntigravityQuotaSummary(
  connection: ProviderConnection,
  projectId: string,
  signal?: AbortSignal,
): Promise<AntigravityQuotaSummaryPayload> {
  let lastError = "Antigravity quota request failed"
  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    const response = await executeUpstreamProxyCall(connection, {
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
    return payload
  }
  throw new Error(lastError)
}

/** 读取 projectId(context 优先,回退迁移期的 credentialExtras)。 */
function readConnectionProjectId(
  connection: ProviderConnection,
): string | undefined {
  const fromContext = getCredentialContextString(connection, "projectId")
  if (fromContext) return fromContext
  const extras = connection.metadata?.credentialExtras as
    | Record<string, unknown>
    | undefined
  const value = extras?.projectId
  return typeof value === "string" && value ? value : undefined
}
