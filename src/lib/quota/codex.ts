import type { Account } from "~/lib/accounts"
import type {
  CodexRateLimitInfo,
  CodexUsagePayload,
  CodexUsageWindow,
} from "~/lib/quota/parsers"

import { getOAuthAccountId, isOAuthAccount } from "~/lib/accounts"
import {
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_URL,
  CODEX_REQUEST_HEADERS,
  CODEX_USAGE_URL,
} from "~/lib/quota/constants"
import { parseCodexUsagePayload } from "~/lib/quota/parsers"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import {
  extractCodexPlanTypeFromIdToken,
  extractCodexSubscriptionActiveUntilFromIdToken,
} from "~/services/oauth/jwt"

const FIVE_HOUR_SECONDS = 18_000
const WEEK_SECONDS = 604_800
const MIN_MONTH_SECONDS = 28 * 24 * 60 * 60
const MAX_MONTH_SECONDS = 31 * 24 * 60 * 60

function normalizeCodexWindowId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
}

export interface CodexQuotaWindowEntry {
  id: string
  labelKey: string
  labelParams?: Record<string, string | number>
  usedPercent: number | null
  resetAtSeconds: number | null
  windowStartMs: number | null
  windowEndMs: number | null
}

export interface CodexResetCreditDetail {
  id: string
  status: string
  grantedAt: string
  expiresAt: string
}

export interface CodexQuotaMeta {
  planType: string | null
  subscriptionActiveUntil: string | number | null
  rateLimitResetCreditsAvailableCount: number | null
  rateLimitResetCredits: Array<CodexResetCreditDetail>
  rateLimitResetCreditsError: string | null
  windows: Array<CodexQuotaWindowEntry>
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

function normalizePlanType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim().toLowerCase()
  return trimmed || null
}

function getWindowSeconds(window?: CodexUsageWindow | null): number | null {
  if (!window) {
    return null
  }
  const seconds = normalizeNumber(
    window.limit_window_seconds ?? window.limitWindowSeconds,
  )
  return seconds ?? null
}

function isMonthlyWindow(window?: CodexUsageWindow | null): boolean {
  const seconds = getWindowSeconds(window)
  return (
    seconds !== null
    && seconds >= MIN_MONTH_SECONDS
    && seconds <= MAX_MONTH_SECONDS
  )
}

function resolveCodexResetAtSeconds(
  window?: CodexUsageWindow | null,
): number | null {
  if (!window) {
    return null
  }
  const resetAt = normalizeNumber(window.reset_at ?? window.resetAt)
  if (resetAt !== undefined && resetAt > 0) {
    return Math.floor(resetAt)
  }
  const resetAfter = normalizeNumber(
    window.reset_after_seconds ?? window.resetAfterSeconds,
  )
  if (resetAfter !== undefined && resetAfter > 0) {
    return Math.floor(Date.now() / 1000 + resetAfter)
  }
  return null
}

function pickClassifiedWindows(
  limitInfo?: CodexRateLimitInfo | null,
  options?: { allowOrderFallback?: boolean },
): {
  fiveHourWindow: CodexUsageWindow | null
  weeklyWindow: CodexUsageWindow | null
} {
  const allowOrderFallback = options?.allowOrderFallback ?? true
  const primaryWindow =
    limitInfo?.primary_window ?? limitInfo?.primaryWindow ?? null
  const secondaryWindow =
    limitInfo?.secondary_window ?? limitInfo?.secondaryWindow ?? null
  const rawWindows = [primaryWindow, secondaryWindow]

  let fiveHourWindow: CodexUsageWindow | null = null
  let weeklyWindow: CodexUsageWindow | null = null

  for (const window of rawWindows) {
    if (!window) {
      continue
    }
    const seconds = getWindowSeconds(window)
    if (seconds === FIVE_HOUR_SECONDS && !fiveHourWindow) {
      fiveHourWindow = window
    } else if (
      (seconds === WEEK_SECONDS || isMonthlyWindow(window))
      && !weeklyWindow
    ) {
      weeklyWindow = window
    }
  }

  if (allowOrderFallback) {
    if (!fiveHourWindow) {
      fiveHourWindow =
        primaryWindow && primaryWindow !== weeklyWindow ? primaryWindow : null
    }
    if (!weeklyWindow) {
      weeklyWindow =
        secondaryWindow && secondaryWindow !== fiveHourWindow ?
          secondaryWindow
        : null
    }
  }

  return { fiveHourWindow, weeklyWindow }
}

function selectSecondaryWindowMeta<
  TWeekly extends { id: string; labelKey: string },
  TMonthly extends { id: string; labelKey: string },
>(
  window: CodexUsageWindow | null | undefined,
  weeklyMeta: TWeekly,
  monthlyMeta: TMonthly,
): TWeekly | TMonthly {
  return isMonthlyWindow(window) ? monthlyMeta : weeklyMeta
}

function addCodexWindowEntry(
  windows: Array<CodexQuotaWindowEntry>,
  entry: {
    id: string
    labelKey: string
    labelParams?: Record<string, string | number>
    window?: CodexUsageWindow | null
    limitReached?: boolean
    allowed?: boolean
  },
): void {
  if (!entry.window) {
    return
  }
  const resetAtSeconds = resolveCodexResetAtSeconds(entry.window)
  const usedPercentRaw = normalizeNumber(
    entry.window.used_percent ?? entry.window.usedPercent,
  )
  const isLimitReached = Boolean(entry.limitReached) || entry.allowed === false
  const usedPercent =
    usedPercentRaw ?? (isLimitReached && resetAtSeconds !== null ? 100 : null)

  const durationSeconds = getWindowSeconds(entry.window)
  let windowEndMs: number | null = null
  let windowStartMs: number | null = null
  if (resetAtSeconds !== null) {
    windowEndMs = resetAtSeconds * 1000
    if (durationSeconds !== null) {
      windowStartMs = windowEndMs - durationSeconds * 1000
    }
  }

  windows.push({
    id: entry.id,
    labelKey: entry.labelKey,
    labelParams: entry.labelParams,
    usedPercent: usedPercent ?? null,
    resetAtSeconds,
    windowStartMs,
    windowEndMs,
  })
}

export function buildCodexQuotaWindows(
  payload: CodexUsagePayload,
): Array<CodexQuotaWindowEntry> {
  const WINDOW_META = {
    codeFiveHour: {
      id: "five-hour",
      labelKey: "quota.oauth.codex.fiveHour",
    },
    codeWeekly: {
      id: "weekly",
      labelKey: "quota.oauth.codex.weekly",
    },
    codeMonthly: {
      id: "monthly",
      labelKey: "quota.oauth.codex.monthly",
    },
    codeReviewFiveHour: {
      id: "code-review-five-hour",
      labelKey: "quota.oauth.codex.codeReviewFiveHour",
    },
    codeReviewWeekly: {
      id: "code-review-weekly",
      labelKey: "quota.oauth.codex.codeReviewWeekly",
    },
    codeReviewMonthly: {
      id: "code-review-monthly",
      labelKey: "quota.oauth.codex.codeReviewMonthly",
    },
  } as const

  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? undefined
  const codeReviewLimit =
    payload.code_review_rate_limit ?? payload.codeReviewRateLimit ?? undefined
  const additionalRateLimits =
    payload.additional_rate_limits ?? payload.additionalRateLimits ?? []
  const windows: Array<CodexQuotaWindowEntry> = []

  const rawLimitReached = rateLimit?.limit_reached ?? rateLimit?.limitReached
  const rawAllowed = rateLimit?.allowed
  const rateWindows = pickClassifiedWindows(rateLimit)

  addCodexWindowEntry(windows, {
    id: WINDOW_META.codeFiveHour.id,
    labelKey: WINDOW_META.codeFiveHour.labelKey,
    window: rateWindows.fiveHourWindow,
    limitReached: rawLimitReached,
    allowed: rawAllowed,
  })

  const codeSecondaryWindowMeta = selectSecondaryWindowMeta(
    rateWindows.weeklyWindow,
    WINDOW_META.codeWeekly,
    WINDOW_META.codeMonthly,
  )
  addCodexWindowEntry(windows, {
    id: codeSecondaryWindowMeta.id,
    labelKey: codeSecondaryWindowMeta.labelKey,
    window: rateWindows.weeklyWindow,
    limitReached: rawLimitReached,
    allowed: rawAllowed,
  })

  const codeReviewWindows = pickClassifiedWindows(codeReviewLimit)
  const codeReviewLimitReached =
    codeReviewLimit?.limit_reached ?? codeReviewLimit?.limitReached
  const codeReviewAllowed = codeReviewLimit?.allowed

  addCodexWindowEntry(windows, {
    id: WINDOW_META.codeReviewFiveHour.id,
    labelKey: WINDOW_META.codeReviewFiveHour.labelKey,
    window: codeReviewWindows.fiveHourWindow,
    limitReached: codeReviewLimitReached,
    allowed: codeReviewAllowed,
  })

  const codeReviewSecondaryWindowMeta = selectSecondaryWindowMeta(
    codeReviewWindows.weeklyWindow,
    WINDOW_META.codeReviewWeekly,
    WINDOW_META.codeReviewMonthly,
  )
  addCodexWindowEntry(windows, {
    id: codeReviewSecondaryWindowMeta.id,
    labelKey: codeReviewSecondaryWindowMeta.labelKey,
    window: codeReviewWindows.weeklyWindow,
    limitReached: codeReviewLimitReached,
    allowed: codeReviewAllowed,
  })

  for (const [index, limitItem] of additionalRateLimits.entries()) {
    const rateInfo = limitItem.rate_limit ?? limitItem.rateLimit ?? null
    if (!rateInfo) {
      continue
    }

    const limitName =
      (typeof limitItem.limit_name === "string" && limitItem.limit_name.trim())
      || (typeof limitItem.limitName === "string" && limitItem.limitName.trim())
      || (typeof limitItem.metered_feature === "string"
        && limitItem.metered_feature.trim())
      || (typeof limitItem.meteredFeature === "string"
        && limitItem.meteredFeature.trim())
      || `additional-${index + 1}`

    const idPrefix =
      normalizeCodexWindowId(limitName) || `additional-${index + 1}`
    const additionalPrimaryWindow =
      rateInfo.primary_window ?? rateInfo.primaryWindow ?? null
    const additionalSecondaryWindow =
      rateInfo.secondary_window ?? rateInfo.secondaryWindow ?? null
    const additionalLimitReached =
      rateInfo.limit_reached ?? rateInfo.limitReached
    const additionalAllowed = rateInfo.allowed

    addCodexWindowEntry(windows, {
      id: `${idPrefix}-five-hour-${index}`,
      labelKey: "quota.oauth.codex.additionalFiveHour",
      labelParams: { name: limitName },
      window: additionalPrimaryWindow,
      limitReached: additionalLimitReached,
      allowed: additionalAllowed,
    })

    const additionalSecondaryMeta = selectSecondaryWindowMeta(
      additionalSecondaryWindow,
      {
        id: "weekly",
        labelKey: "quota.oauth.codex.additionalWeekly",
      },
      {
        id: "monthly",
        labelKey: "quota.oauth.codex.additionalMonthly",
      },
    )
    addCodexWindowEntry(windows, {
      id: `${idPrefix}-${additionalSecondaryMeta.id}-${index}`,
      labelKey: additionalSecondaryMeta.labelKey,
      labelParams: { name: limitName },
      window: additionalSecondaryWindow,
      limitReached: additionalLimitReached,
      allowed: additionalAllowed,
    })
  }

  return windows
}

export function resolveCodexSubscriptionActiveUntil(
  account: Account,
): string | number | null {
  if (!isOAuthAccount(account)) {
    return null
  }
  const idToken = account.credentials?.idToken
  return extractCodexSubscriptionActiveUntilFromIdToken(idToken) ?? null
}

export function resolveCodexPlanType(
  account: Account,
  payload?: CodexUsagePayload | null,
): string | null {
  const planTypeFromUsage = normalizePlanType(
    payload?.plan_type ?? payload?.planType,
  )
  if (planTypeFromUsage) {
    return planTypeFromUsage
  }
  if (!isOAuthAccount(account)) {
    return null
  }
  return extractCodexPlanTypeFromIdToken(account.credentials?.idToken) ?? null
}

function asTrimmedString(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }
  return ""
}

function normalizeCodexResetCreditDetail(
  value: unknown,
): CodexResetCreditDetail | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const resetType = asTrimmedString(
    record.reset_type ?? record.resetType,
  ).toLowerCase()
  if (resetType && resetType !== "codex_rate_limits") return null
  const status = asTrimmedString(record.status).toLowerCase()
  if (status && status !== "available") return null
  const expiresAt = asTrimmedString(record.expires_at ?? record.expiresAt)
  if (!expiresAt) return null
  return {
    id: asTrimmedString(record.id),
    status: status || "available",
    grantedAt: asTrimmedString(record.granted_at ?? record.grantedAt),
    expiresAt,
  }
}

export function parseCodexResetCreditsPayload(payload: unknown): {
  availableCount: number | null
  credits: Array<CodexResetCreditDetail>
} {
  let parsed = payload
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload.trim()) as unknown
    } catch {
      return { availableCount: null, credits: [] }
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { availableCount: null, credits: [] }
  }
  const record = parsed as Record<string, unknown>
  const credits =
    Array.isArray(record.credits) ?
      record.credits
        .map((item) => normalizeCodexResetCreditDetail(item))
        .filter((item): item is CodexResetCreditDetail => item !== null)
    : []
  const availableCount =
    normalizeNumber(record.available_count ?? record.availableCount) ?? null
  return { availableCount, credits }
}

export function buildCodexQuotaMeta(
  account: Account,
  payload: CodexUsagePayload,
  resetCreditsDetails?: {
    availableCount: number | null
    credits: Array<CodexResetCreditDetail>
    error: string | null
  },
): CodexQuotaMeta {
  const resetCredits =
    payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits ?? null
  const usageAvailableCount =
    normalizeNumber(
      resetCredits?.available_count ?? resetCredits?.availableCount,
    ) ?? null
  const detailsCount =
    resetCreditsDetails && resetCreditsDetails.credits.length > 0 ?
      resetCreditsDetails.credits.length
    : null
  const rateLimitResetCreditsAvailableCount =
    resetCreditsDetails?.availableCount ?? detailsCount ?? usageAvailableCount

  return {
    planType: resolveCodexPlanType(account, payload),
    subscriptionActiveUntil: resolveCodexSubscriptionActiveUntil(account),
    rateLimitResetCreditsAvailableCount,
    rateLimitResetCredits: resetCreditsDetails?.credits ?? [],
    rateLimitResetCreditsError: resetCreditsDetails?.error ?? null,
    windows: buildCodexQuotaWindows(payload),
  }
}

function createCodexRedeemRequestId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replaceAll(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16)
    const segment = char === "x" ? value : (value & 0x3) | 0x8
    return segment.toString(16)
  })
}

function buildCodexRequestHeaders(account: Account): Record<string, string> {
  const headers: Record<string, string> = { ...CODEX_REQUEST_HEADERS }
  const accountId = getOAuthAccountId(account)
  if (accountId) {
    headers["Chatgpt-Account-Id"] = accountId
  }
  return headers
}

export async function fetchCodexResetCredits(
  account: Account,
  signal?: AbortSignal,
): Promise<{
  availableCount: number | null
  credits: Array<CodexResetCreditDetail>
  error: string | null
}> {
  try {
    const response = await executeUpstreamProxyCall(account, {
      method: "GET",
      url: CODEX_RATE_LIMIT_RESET_CREDITS_URL,
      headers: buildCodexRequestHeaders(account),
      signal,
    })
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        availableCount: null,
        credits: [],
        error: `HTTP ${response.statusCode}`,
      }
    }
    const summary = parseCodexResetCreditsPayload(response.body)
    return {
      availableCount: summary.availableCount,
      credits: summary.credits,
      error: null,
    }
  } catch (error) {
    return {
      availableCount: null,
      credits: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function consumeCodexRateLimitResetCredit(
  account: Account,
  signal?: AbortSignal,
): Promise<void> {
  if (!isOAuthAccount(account) || account.provider !== "codex") {
    throw new Error(
      "consumeCodexRateLimitResetCredit requires a Codex OAuth account",
    )
  }

  const response = await executeUpstreamProxyCall(account, {
    method: "POST",
    url: CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
    headers: buildCodexRequestHeaders(account),
    body: JSON.stringify({
      redeem_request_id: createCodexRedeemRequestId(),
    }),
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Codex quota reset failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }
}

export async function fetchCodexUsagePayload(
  account: Account,
  signal?: AbortSignal,
): Promise<CodexUsagePayload> {
  const response = await executeUpstreamProxyCall(account, {
    method: "GET",
    url: CODEX_USAGE_URL,
    headers: buildCodexRequestHeaders(account),
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Codex quota request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }

  const payload = parseCodexUsagePayload(response.body)
  if (!payload) {
    throw new Error("Codex quota response was empty or invalid")
  }

  return payload
}

export async function resetCodexQuota(
  account: Account,
  signal?: AbortSignal,
): Promise<CodexUsagePayload> {
  await consumeCodexRateLimitResetCredit(account, signal)
  return fetchCodexUsagePayload(account, signal)
}

export function canResetCodexQuota(meta: CodexQuotaMeta | undefined): boolean {
  return (meta?.rateLimitResetCreditsAvailableCount ?? 0) > 0
}
