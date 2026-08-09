import type { OAuthProviderId } from "~/lib/provider-config"
import type {
  ClaudeUsagePayload,
  AntigravityQuotaSummaryPayload,
  KimiUsagePayload,
} from "~/lib/quota/parsers"

import {
  buildCodexQuotaWindows,
  type CodexQuotaWindowEntry,
} from "~/lib/quota/codex"
import { CLAUDE_USAGE_WINDOW_KEYS } from "~/lib/quota/constants"
import { parseCodexUsagePayload } from "~/lib/quota/parsers"
import { statsStore } from "~/lib/stats-store"

export const CYCLE_USAGE_PROVIDERS = new Set<OAuthProviderId>([
  "codex",
  "claude",
  "antigravity",
  "kimi",
])

export interface CycleUsageModelSummary {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
}

export interface CycleUsageSummary {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
  models: Record<string, CycleUsageModelSummary>
}

export interface QuotaWindowDescriptor {
  id: string
  labelKey: string
  labelParams?: Record<string, string | number>
  windowStartMs: number
  windowEndMs: number
  usedPercent?: number | null
  resetAtSeconds?: number | null
  cycleUsage?: CycleUsageSummary
}

const CLAUDE_WINDOW_LABEL_KEYS: Record<string, string> = {
  five_hour: "quota.oauth.claude.fiveHour",
  seven_day: "quota.oauth.claude.sevenDay",
  seven_day_oauth_apps: "quota.oauth.claude.sevenDayOAuth",
  seven_day_opus: "quota.oauth.claude.sevenDayOpus",
  seven_day_sonnet: "quota.oauth.claude.sevenDaySonnet",
  seven_day_cowork: "quota.oauth.claude.sevenDayCowork",
  iguana_necktie: "quota.oauth.claude.iguanaNecktie",
}

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

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

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined
  }
  const ms = new Date(value.trim()).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

function claudeWindowDurationMs(key: string): number | undefined {
  if (key === "five_hour") {
    return 5 * MS_PER_HOUR
  }
  if (key.startsWith("seven_day") || key === "iguana_necktie") {
    return 7 * MS_PER_DAY
  }
  return undefined
}

function antigravityWindowDurationMs(window?: string): number | undefined {
  if (!window) {
    return undefined
  }
  const normalized = window.trim().toLowerCase().replaceAll(/\s+/g, "_")
  if (
    normalized === "5h"
    || normalized === "five_hour"
    || normalized === "five-hour"
    || normalized === "five_hour_limit"
  ) {
    return 5 * MS_PER_HOUR
  }
  if (
    normalized === "weekly"
    || normalized === "week"
    || normalized === "weekly_limit"
  ) {
    return 7 * MS_PER_DAY
  }
  if (
    normalized === "daily"
    || normalized === "day"
    || normalized === "daily_limit"
  ) {
    return MS_PER_DAY
  }
  if (normalized === "monthly" || normalized === "month") {
    return 30 * MS_PER_DAY
  }
  return undefined
}

function kimiResetEndMs(data: Record<string, unknown>): number | undefined {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const absolute = parseIsoMs(data[key])
    if (absolute !== undefined) {
      return absolute
    }
  }
  for (const key of ["reset_in", "resetIn", "ttl"]) {
    const seconds = normalizeNumber(data[key])
    if (seconds !== undefined && seconds > 0) {
      return Date.now() + seconds * 1000
    }
  }
  return undefined
}

function kimiWindowDurationMs(
  data: Record<string, unknown>,
  endMs: number,
): number | undefined {
  const duration = normalizeNumber(data.duration)
  const timeUnit =
    typeof data.timeUnit === "string" ? data.timeUnit.trim().toUpperCase() : ""
  if (duration !== undefined && duration > 0) {
    if (timeUnit === "MINUTES") {
      return duration % 60 === 0 ?
          (duration / 60) * MS_PER_HOUR
        : duration * 60_000
    }
    if (timeUnit === "HOURS") {
      return duration * MS_PER_HOUR
    }
    if (timeUnit === "DAYS") {
      return duration * MS_PER_DAY
    }
    return duration * 1000
  }
  const startFromReset = kimiResetEndMs(data)
  if (startFromReset !== undefined && startFromReset < endMs) {
    return endMs - startFromReset
  }
  return undefined
}

function codexEntryToDescriptor(
  entry: CodexQuotaWindowEntry,
): QuotaWindowDescriptor | null {
  if (
    entry.windowStartMs === null
    || entry.windowEndMs === null
    || entry.windowStartMs <= 0
    || entry.windowEndMs <= 0
  ) {
    return null
  }
  return {
    id: entry.id,
    labelKey: entry.labelKey,
    labelParams: entry.labelParams,
    windowStartMs: entry.windowStartMs,
    windowEndMs: entry.windowEndMs,
    usedPercent: entry.usedPercent,
    resetAtSeconds: entry.resetAtSeconds,
  }
}

export function resolveCodexQuotaWindows(
  details: Record<string, unknown>,
): Array<QuotaWindowDescriptor> {
  const payload = parseCodexUsagePayload(details)
  if (!payload) {
    return []
  }
  return buildCodexQuotaWindows(payload)
    .map((entry) => codexEntryToDescriptor(entry))
    .filter((entry): entry is QuotaWindowDescriptor => entry !== null)
}

export function resolveClaudeQuotaWindows(
  details: Record<string, unknown>,
): Array<QuotaWindowDescriptor> {
  const payload = details as ClaudeUsagePayload
  const windows: Array<QuotaWindowDescriptor> = []

  for (const key of CLAUDE_USAGE_WINDOW_KEYS) {
    const window = payload[key as keyof ClaudeUsagePayload]
    if (!window || typeof window !== "object" || !("utilization" in window)) {
      continue
    }
    const typedWindow = window as { utilization?: number; resets_at?: string }
    const windowEndMs = parseIsoMs(typedWindow.resets_at)
    const durationMs = claudeWindowDurationMs(key)
    if (windowEndMs === undefined || durationMs === undefined) {
      continue
    }
    const usedPercent =
      typeof typedWindow.utilization === "number" ?
        Math.max(0, Math.min(100, typedWindow.utilization * 100))
      : null
    windows.push({
      id: key,
      labelKey: CLAUDE_WINDOW_LABEL_KEYS[key] ?? `quota.oauth.claude.${key}`,
      windowStartMs: windowEndMs - durationMs,
      windowEndMs,
      usedPercent,
      resetAtSeconds: Math.floor(windowEndMs / 1000),
    })
  }

  return windows
}

export function resolveAntigravityQuotaWindows(
  details: Record<string, unknown>,
): Array<QuotaWindowDescriptor> {
  const payload = details as AntigravityQuotaSummaryPayload
  const windows: Array<QuotaWindowDescriptor> = []

  for (const group of payload.groups ?? []) {
    // `||` throughout: these are camelCase/snake_case spellings of one field,
    // and an upstream that emits the unused spelling as "" must not shadow the
    // populated one.
    const groupLabel = group.displayName || group.display_name || "quota-group"
    for (const bucket of group.buckets ?? []) {
      const windowEndMs = parseIsoMs(bucket.resetTime ?? bucket.reset_time)
      const durationMs = antigravityWindowDurationMs(bucket.window)
      if (windowEndMs === undefined || durationMs === undefined) {
        continue
      }
      const bucketId =
        bucket.bucketId || bucket.bucket_id || bucket.window || "bucket"
      const bucketLabel = bucket.displayName || bucket.display_name || bucketId
      const fraction = normalizeNumber(
        bucket.remainingFraction ?? bucket.remaining_fraction,
      )
      const usedPercent =
        fraction !== undefined ?
          Math.max(0, Math.min(100, (1 - fraction) * 100))
        : null
      windows.push({
        id: `${groupLabel}-${bucketId}`,
        labelKey: "quota.oauth.antigravity.bucketCycle",
        labelParams: { group: groupLabel, bucket: bucketLabel },
        windowStartMs: windowEndMs - durationMs,
        windowEndMs,
        usedPercent,
        resetAtSeconds: Math.floor(windowEndMs / 1000),
      })
    }
  }

  return windows
}

export function resolveKimiQuotaWindows(
  details: Record<string, unknown>,
): Array<QuotaWindowDescriptor> {
  const payload = details as KimiUsagePayload
  const windows: Array<QuotaWindowDescriptor> = []
  const now = Date.now()

  const candidates: Array<{
    id: string
    labelKey: string
    labelParams?: Record<string, string | number>
    data: Record<string, unknown>
  }> = []

  if (payload.usage && typeof payload.usage === "object") {
    candidates.push({
      id: "summary",
      labelKey: "quota.oauth.kimi.usage",
      data: payload.usage as Record<string, unknown>,
    })
  }

  for (const [index, item] of (payload.limits ?? []).entries()) {
    const detail = (
      item.detail && typeof item.detail === "object" ?
        item.detail
      : item) as Record<string, unknown>
    const label =
      (typeof item.title === "string" && item.title.trim())
      || (typeof item.name === "string" && item.name.trim())
      || `limit-${index + 1}`
    candidates.push({
      id: `limit-${index}`,
      labelKey: "quota.oauth.kimi.limitCycle",
      labelParams: { name: label },
      data: { ...detail, ...item.window },
    })
  }

  for (const candidate of candidates) {
    const windowEndMs = kimiResetEndMs(candidate.data) ?? now
    const durationMs = kimiWindowDurationMs(candidate.data, windowEndMs)
    if (durationMs === undefined) {
      continue
    }
    windows.push({
      id: candidate.id,
      labelKey: candidate.labelKey,
      labelParams: candidate.labelParams,
      windowStartMs: windowEndMs - durationMs,
      windowEndMs,
      resetAtSeconds: Math.floor(windowEndMs / 1000),
    })
  }

  return windows
}

const CYCLE_WINDOW_RESOLVERS: Partial<
  Record<
    OAuthProviderId,
    (details: Record<string, unknown>) => Array<QuotaWindowDescriptor>
  >
> = {
  codex: resolveCodexQuotaWindows,
  claude: resolveClaudeQuotaWindows,
  antigravity: resolveAntigravityQuotaWindows,
  kimi: resolveKimiQuotaWindows,
}

export function resolveQuotaWindows(
  provider: OAuthProviderId,
  details: Record<string, unknown> | undefined,
): Array<QuotaWindowDescriptor> {
  if (!details || typeof details !== "object") {
    return []
  }
  if (Array.isArray(details._quotaWindows)) {
    return details._quotaWindows as Array<QuotaWindowDescriptor>
  }

  const resolver = CYCLE_WINDOW_RESOLVERS[provider]
  return resolver ? resolver(details) : []
}

export function supportsCycleUsage(provider: string | undefined): boolean {
  return CYCLE_USAGE_PROVIDERS.has(provider as OAuthProviderId)
}

export function attachCycleUsage(
  accountId: string,
  windows: Array<QuotaWindowDescriptor>,
): Array<QuotaWindowDescriptor> {
  const now = Date.now()
  return windows.map((window) => {
    const endMs = Math.min(window.windowEndMs, now)
    const cycleUsage = statsStore.getUsageByTimestampRange(
      accountId,
      window.windowStartMs,
      endMs,
    )
    return {
      ...window,
      cycleUsage,
    }
  })
}

export function buildStoredQuotaWindows(
  provider: OAuthProviderId,
  details: Record<string, unknown>,
): Array<QuotaWindowDescriptor> {
  const resolver = CYCLE_WINDOW_RESOLVERS[provider]
  return resolver ? resolver(details) : []
}

export function enrichQuotaDetails(
  provider: OAuthProviderId,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const windows = buildStoredQuotaWindows(provider, details)
  if (windows.length === 0) {
    return details
  }
  return {
    ...details,
    _quotaWindows: windows,
  }
}

export function enrichQuotaInfoForResponse(
  accountId: string,
  provider: string | undefined,
  quotaInfo: { details?: Record<string, unknown> } | null | undefined,
): { details?: Record<string, unknown> } | null | undefined {
  if (!quotaInfo?.details || !supportsCycleUsage(provider)) {
    return quotaInfo
  }
  const windows = resolveQuotaWindows(
    provider as OAuthProviderId,
    quotaInfo.details,
  )
  if (windows.length === 0) {
    return quotaInfo
  }
  return {
    ...quotaInfo,
    details: {
      ...quotaInfo.details,
      _quotaWindows: attachCycleUsage(accountId, windows),
    },
  }
}
