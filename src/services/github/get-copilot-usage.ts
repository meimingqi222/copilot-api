import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

type QuotaKey = "premium_interactions" | "chat" | "completions"

interface NumericQuotaMap {
  premium_interactions?: number
  chat?: number
  completions?: number
}

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
}

interface QuotaSnapshots {
  chat?: QuotaDetail
  completions?: QuotaDetail
  premium_interactions?: QuotaDetail
}

interface RawCopilotUsageResponse {
  access_type_sku?: string
  analytics_tracking_id?: string
  assigned_date?: string
  can_signup_for_limited?: boolean
  chat_enabled?: boolean
  copilot_plan?: string
  organization_login_list?: Array<unknown>
  organization_list?: Array<unknown>
  quota_reset_date?: string
  quota_snapshots?: QuotaSnapshots
  limited_user_reset_date?: string
  limited_user_quotas?: NumericQuotaMap
  monthly_quotas?: NumericQuotaMap
}

export interface CopilotUsageResponse {
  access_type_sku?: string
  analytics_tracking_id?: string
  assigned_date?: string
  can_signup_for_limited?: boolean
  chat_enabled?: boolean
  copilot_plan?: string
  organization_login_list?: Array<unknown>
  organization_list?: Array<unknown>
  quota_reset_date?: string
  quota_snapshots?: QuotaSnapshots
}

const quotaKeys: Array<QuotaKey> = [
  "premium_interactions",
  "chat",
  "completions",
]

export const getCopilotUsage = async (): Promise<CopilotUsageResponse> => {
  const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: githubHeaders(state),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot usage", response)
  }

  const raw = (await response.json()) as RawCopilotUsageResponse
  return normalizeUsageResponse(raw)
}

function normalizeUsageResponse(
  raw: RawCopilotUsageResponse,
): CopilotUsageResponse {
  return {
    access_type_sku: raw.access_type_sku,
    analytics_tracking_id: raw.analytics_tracking_id,
    assigned_date: raw.assigned_date,
    can_signup_for_limited: raw.can_signup_for_limited,
    chat_enabled: raw.chat_enabled,
    copilot_plan: raw.copilot_plan,
    organization_login_list: raw.organization_login_list,
    organization_list: raw.organization_list,
    quota_reset_date: raw.quota_reset_date ?? raw.limited_user_reset_date,
    quota_snapshots: normalizeQuotaSnapshots(raw),
  }
}

function normalizeQuotaSnapshots(
  raw: RawCopilotUsageResponse,
): QuotaSnapshots | undefined {
  const snapshots: QuotaSnapshots = {}

  for (const key of quotaKeys) {
    const existingQuota = raw.quota_snapshots?.[key]
    if (existingQuota) {
      snapshots[key] = existingQuota
      continue
    }

    const derivedQuota = deriveQuotaDetail(
      key,
      raw.monthly_quotas?.[key],
      raw.limited_user_quotas?.[key],
    )

    if (derivedQuota) {
      snapshots[key] = derivedQuota
    }
  }

  return Object.keys(snapshots).length > 0 ? snapshots : undefined
}

function deriveQuotaDetail(
  key: QuotaKey,
  entitlementValue?: number,
  remainingValue?: number,
): QuotaDetail | undefined {
  const entitlementBase = toNonNegativeNumber(entitlementValue)
  const remainingBase = toNonNegativeNumber(remainingValue)

  if (entitlementBase === undefined && remainingBase === undefined) {
    return undefined
  }

  let entitlement = entitlementBase ?? remainingBase ?? 0
  let remaining = remainingBase ?? entitlement

  if (entitlement === 0 && remaining > 0) {
    entitlement = remaining
  }

  if (entitlement > 0 && remaining > entitlement) {
    remaining = entitlement
  }

  const percentRemaining = entitlement > 0 ? (remaining / entitlement) * 100 : 0

  return {
    entitlement,
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: percentRemaining,
    quota_id: key,
    quota_remaining: remaining,
    remaining,
    unlimited: false,
  }
}

function toNonNegativeNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined
  }

  return Math.max(0, value)
}
