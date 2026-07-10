export interface ClaudeUsageWindow {
  utilization?: number
  resets_at?: string
}

export interface ClaudeUsagePayload {
  five_hour?: ClaudeUsageWindow | null
  seven_day?: ClaudeUsageWindow | null
  seven_day_oauth_apps?: ClaudeUsageWindow | null
  seven_day_opus?: ClaudeUsageWindow | null
  seven_day_sonnet?: ClaudeUsageWindow | null
  seven_day_cowork?: ClaudeUsageWindow | null
  iguana_necktie?: ClaudeUsageWindow | null
  extra_usage?: {
    is_enabled?: boolean
    monthly_limit?: number
    used_credits?: number
    utilization?: number | null
  } | null
}

export interface KimiUsageDetail {
  used?: number
  limit?: number
  remaining?: number
  name?: string
  title?: string
}

export interface KimiLimitItem {
  name?: string
  title?: string
  detail?: KimiUsageDetail
  window?: Record<string, unknown>
  used?: number
  limit?: number
  remaining?: number
}

export interface KimiUsagePayload {
  usage?: KimiUsageDetail
  limits?: Array<KimiLimitItem>
}

export interface AntigravityQuotaBucketPayload {
  bucketId?: string
  bucket_id?: string
  displayName?: string
  display_name?: string
  window?: string
  resetTime?: string
  reset_time?: string
  remainingFraction?: number | string
  remaining_fraction?: number | string
  description?: string
}

export interface AntigravityQuotaGroupPayload {
  displayName?: string
  display_name?: string
  description?: string
  buckets?: Array<AntigravityQuotaBucketPayload>
}

export interface AntigravityQuotaSummaryPayload {
  groups?: Array<AntigravityQuotaGroupPayload>
}

export interface CodexUsageWindow {
  used_percent?: number | string
  usedPercent?: number | string
  limit_window_seconds?: number | string
  limitWindowSeconds?: number | string
  reset_after_seconds?: number | string
  resetAfterSeconds?: number | string
  reset_at?: number | string
  resetAt?: number | string
}

export interface CodexRateLimitInfo {
  allowed?: boolean
  limit_reached?: boolean
  limitReached?: boolean
  primary_window?: CodexUsageWindow | null
  primaryWindow?: CodexUsageWindow | null
  secondary_window?: CodexUsageWindow | null
  secondaryWindow?: CodexUsageWindow | null
}

export interface CodexAdditionalRateLimit {
  limit_name?: string
  limitName?: string
  metered_feature?: string
  meteredFeature?: string
  rate_limit?: CodexRateLimitInfo | null
  rateLimit?: CodexRateLimitInfo | null
}

export interface CodexRateLimitResetCredits {
  available_count?: number | string
  availableCount?: number | string
}

export interface CodexUsagePayload {
  plan_type?: string
  planType?: string
  rate_limit?: CodexRateLimitInfo | null
  rateLimit?: CodexRateLimitInfo | null
  code_review_rate_limit?: CodexRateLimitInfo | null
  codeReviewRateLimit?: CodexRateLimitInfo | null
  additional_rate_limits?: Array<CodexAdditionalRateLimit> | null
  additionalRateLimits?: Array<CodexAdditionalRateLimit> | null
  rate_limit_reset_credits?: CodexRateLimitResetCredits | null
  rateLimitResetCredits?: CodexRateLimitResetCredits | null
}

export interface XaiBillingCent {
  val?: number | string
}

export interface XaiBillingPeriod {
  type?: string
  start?: string
  end?: string
}

export interface XaiProductUsage {
  product?: string
  usagePercent?: number
}

export interface XaiBillingConfig {
  monthlyLimit?: XaiBillingCent | number | string | null
  monthly_limit?: XaiBillingCent | number | string | null
  used?: XaiBillingCent | number | string | null
  onDemandCap?: XaiBillingCent | number | string | null
  on_demand_cap?: XaiBillingCent | number | string | null
  onDemandUsed?: XaiBillingCent | number | string | null
  on_demand_used?: XaiBillingCent | number | string | null
  currentPeriod?: XaiBillingPeriod | null
  creditUsagePercent?: number
  productUsage?: Array<XaiProductUsage>
  isUnifiedBillingUser?: boolean
  prepaidBalance?: XaiBillingCent | number | string | null
  topUpMethod?: string
  billingPeriodStart?: string
  billing_period_start?: string
  billingPeriodEnd?: string
  billing_period_end?: string
  // Preserved base (monthly) billing period when weekly credits payload overwrites it
  monthlyBillingPeriodStart?: string
  monthly_billing_period_start?: string
  monthlyBillingPeriodEnd?: string
  monthly_billing_period_end?: string
}

export interface XaiBillingPayload {
  config?: XaiBillingConfig | null
}

function parseJsonPayload(payload: unknown): Record<string, unknown> | null {
  if (payload === undefined || payload === null) {
    return null
  }
  if (typeof payload === "string") {
    const trimmed = payload.trim()
    if (!trimmed) {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return null
    } catch {
      return null
    }
  }
  if (typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return null
}

export function parseClaudeUsagePayload(
  payload: unknown,
): ClaudeUsagePayload | null {
  const parsed = parseJsonPayload(payload)
  return parsed as ClaudeUsagePayload | null
}

export function parseKimiUsagePayload(
  payload: unknown,
): KimiUsagePayload | null {
  const parsed = parseJsonPayload(payload)
  return parsed as KimiUsagePayload | null
}

export function parseAntigravityQuotaPayload(
  payload: unknown,
): AntigravityQuotaSummaryPayload | null {
  const parsed = parseJsonPayload(payload)
  if (!parsed) {
    return null
  }
  if (Array.isArray(parsed.groups)) {
    return parsed as AntigravityQuotaSummaryPayload
  }
  const nested = parseJsonPayload(parsed.body)
  if (nested && Array.isArray(nested.groups)) {
    return nested as AntigravityQuotaSummaryPayload
  }
  return parsed as AntigravityQuotaSummaryPayload
}

function normalizeQuotaFraction(value: unknown): number | undefined {
  const normalized = normalizeNumber(value)
  if (normalized !== undefined) {
    return normalized
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.endsWith("%")) {
      const parsed = Number(trimmed.slice(0, -1))
      if (Number.isFinite(parsed)) {
        return parsed / 100
      }
    }
  }
  return undefined
}

export function summarizeAntigravityQuota(
  payload: AntigravityQuotaSummaryPayload,
): {
  remainingFraction: number | undefined
  unlimited: boolean
} {
  let minRemaining: number | undefined

  for (const group of payload.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      const remaining = normalizeQuotaFraction(
        bucket.remainingFraction ?? bucket.remaining_fraction,
      )
      if (remaining === undefined) {
        continue
      }
      minRemaining =
        minRemaining === undefined ? remaining : (
          Math.min(minRemaining, remaining)
        )
    }
  }

  return {
    remainingFraction: minRemaining,
    unlimited: minRemaining === undefined,
  }
}

export function parseCodexUsagePayload(
  payload: unknown,
): CodexUsagePayload | null {
  const parsed = parseJsonPayload(payload)
  return parsed as CodexUsagePayload | null
}

export function parseXaiBillingPayload(
  payload: unknown,
): XaiBillingPayload | null {
  const parsed = parseJsonPayload(payload)
  return parsed as XaiBillingPayload | null
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

export function summarizeClaudeQuota(payload: ClaudeUsagePayload): {
  remainingFraction: number | undefined
  unlimited: boolean
} {
  let minRemaining: number | undefined

  for (const key of [
    "five_hour",
    "seven_day",
    "seven_day_oauth_apps",
    "seven_day_opus",
    "seven_day_sonnet",
  ] as const) {
    const window = payload[key]
    if (!window || typeof window.utilization !== "number") {
      continue
    }
    const remaining = Math.max(0, 1 - window.utilization)
    minRemaining =
      minRemaining === undefined ? remaining : Math.min(minRemaining, remaining)
  }

  return {
    remainingFraction: minRemaining,
    unlimited: minRemaining === undefined,
  }
}

export function summarizeKimiQuota(payload: KimiUsagePayload): {
  remaining: number | undefined
  total: number | undefined
  unlimited: boolean
} {
  const candidates: Array<{
    remaining?: number
    limit?: number
    used?: number
  }> = []

  if (payload.usage) {
    candidates.push(payload.usage)
  }
  for (const item of payload.limits ?? []) {
    candidates.push(item.detail ?? item)
  }

  let minRemaining: number | undefined
  let matchedTotal: number | undefined

  for (const item of candidates) {
    const limit = normalizeNumber(item.limit)
    const remaining = normalizeNumber(item.remaining)
    const used = normalizeNumber(item.used)
    const computedRemaining =
      remaining
      ?? (limit !== undefined && used !== undefined ?
        Math.max(0, limit - used)
      : undefined)

    if (computedRemaining === undefined) {
      continue
    }

    if (minRemaining === undefined || computedRemaining < minRemaining) {
      minRemaining = computedRemaining
      matchedTotal = limit
    }
  }

  return {
    remaining: minRemaining,
    total: matchedTotal,
    unlimited: minRemaining === undefined,
  }
}

function collectCodexRateLimitWindows(
  limitInfo: CodexRateLimitInfo | null | undefined,
): Array<CodexUsageWindow> {
  if (!limitInfo) {
    return []
  }
  const windows: Array<CodexUsageWindow> = []
  const primary = limitInfo.primary_window ?? limitInfo.primaryWindow
  const secondary = limitInfo.secondary_window ?? limitInfo.secondaryWindow
  if (primary) {
    windows.push(primary)
  }
  if (secondary) {
    windows.push(secondary)
  }
  return windows
}

function getCodexWindowUsedPercent(
  window: CodexUsageWindow,
): number | undefined {
  const used = normalizeNumber(window.used_percent ?? window.usedPercent)
  if (used === undefined) {
    return undefined
  }
  return Math.max(0, Math.min(100, used))
}

export function summarizeCodexQuota(payload: CodexUsagePayload): {
  remainingPercent: number | undefined
  unlimited: boolean
} {
  const windows: Array<CodexUsageWindow> = [
    ...collectCodexRateLimitWindows(
      payload.rate_limit ?? payload.rateLimit ?? undefined,
    ),
    ...collectCodexRateLimitWindows(
      payload.code_review_rate_limit
        ?? payload.codeReviewRateLimit
        ?? undefined,
    ),
  ]

  for (const entry of payload.additional_rate_limits
    ?? payload.additionalRateLimits
    ?? []) {
    windows.push(
      ...collectCodexRateLimitWindows(
        entry.rate_limit ?? entry.rateLimit ?? undefined,
      ),
    )
  }

  let minRemaining: number | undefined
  for (const window of windows) {
    const usedPercent = getCodexWindowUsedPercent(window)
    if (usedPercent === undefined) {
      continue
    }
    const remaining = Math.max(0, 100 - usedPercent)
    minRemaining =
      minRemaining === undefined ? remaining : Math.min(minRemaining, remaining)
  }

  return {
    remainingPercent: minRemaining,
    unlimited: minRemaining === undefined,
  }
}

function normalizeXaiCentValue(
  value: XaiBillingConfig["monthlyLimit"],
): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return normalizeNumber(value.val)
  }
  return normalizeNumber(value)
}

export function summarizeXaiQuota(payload: XaiBillingPayload): {
  remainingPercent: number | undefined
  remainingCents: number | undefined
  totalCents: number | undefined
  unlimited: boolean
} {
  const config = payload.config
  if (!config || typeof config !== "object") {
    return {
      remainingPercent: undefined,
      remainingCents: undefined,
      totalCents: undefined,
      unlimited: true,
    }
  }

  const monthlyLimitCents = normalizeXaiCentValue(
    config.monthlyLimit ?? config.monthly_limit,
  )
  const usedCents = normalizeXaiCentValue(config.used)

  let remainingCents: number | undefined
  let totalCents: number | undefined
  let minRemainingPercent: number | undefined

  if (monthlyLimitCents !== undefined || usedCents !== undefined) {
    remainingCents =
      monthlyLimitCents !== undefined && usedCents !== undefined ?
        Math.max(0, monthlyLimitCents - usedCents)
      : undefined
    totalCents = monthlyLimitCents
    if (
      monthlyLimitCents !== undefined
      && monthlyLimitCents > 0
      && usedCents !== undefined
    ) {
      minRemainingPercent = Math.max(
        0,
        Math.round((1 - usedCents / monthlyLimitCents) * 100),
      )
    }
  }

  if (config.creditUsagePercent !== undefined) {
    const usedPercent = Math.max(0, Math.min(100, config.creditUsagePercent))
    const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent))
    minRemainingPercent =
      minRemainingPercent === undefined ? remainingPercent : (
        Math.min(minRemainingPercent, remainingPercent)
      )
  }

  return {
    remainingPercent: minRemainingPercent,
    remainingCents,
    totalCents,
    unlimited:
      minRemainingPercent === undefined && remainingCents === undefined,
  }
}
