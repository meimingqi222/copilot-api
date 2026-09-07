import { Hono } from "hono"

import type { ProviderId } from "~/lib/provider-config"

import { forwardError, HTTPError } from "~/lib/error"
import {
  getProviderConnection,
  listAccountManagedConnections,
  providerFromProtocol,
} from "~/lib/provider-connections"
import { readJsonBody } from "~/lib/request-body"
import { recordTraceError } from "~/lib/request-log"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import {
  addDays,
  resolveTimeZone,
  startOfDayMs,
  todayInTimeZone,
  weekdayInTimeZone,
} from "~/lib/stats/timezone"

/**
 * Map each exposed model id to the provider of the highest-priority account
 * that serves it, mirroring the priority resolution in `cacheModels()`.
 * Used to give pricing lookups a provider hint so they hit the correct
 * models.dev bucket instead of falling back to the global (provider-agnostic)
 * lookup, which can return stale data from an unrelated provider.
 */
function buildModelProviderHints(): Map<string, ProviderId> {
  const hints = new Map<string, ProviderId>()
  // 使用 connection 原生列表(替代 listAccounts())
  const sortedConnections = listAccountManagedConnections()
    .map((conn, originalIndex) => ({ conn, originalIndex }))
    .sort((left, right) => {
      if (left.conn.priority !== right.conn.priority) {
        return left.conn.priority - right.conn.priority
      }
      return left.originalIndex - right.originalIndex
    })

  for (const { conn } of sortedConnections) {
    const provider = providerFromProtocol(conn.protocol) ?? "copilot"
    for (const model of conn.models ?? []) {
      if (!hints.has(model.publicId)) {
        hints.set(model.publicId, provider as ProviderId)
      }
    }
  }
  return hints
}

export const usageApiRoutes = new Hono()

/** Friendly display names for provider ids (also covers "unknown" orphans). */
const PROVIDER_LABELS: Record<string, string> = {
  copilot: "GitHub Copilot",
  claude: "Claude",
  kimi: "Kimi",
  xai: "xAI",
  codex: "Codex",
  windsurf: "Windsurf",
  antigravity: "Antigravity",
  codebuff: "Codebuff",
  "mimo-aistudio": "MiMo",
  unknown: "Unknown",
  // Protocol values used as provider for plain (non-account-managed) connections.
  "openai-compatible": "OpenAI Compatible",
  "openai-responses-compatible": "OpenAI Responses",
  "anthropic-compatible": "Anthropic Compatible",
}

function providerLabel(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId
}

type UsageMetricsBase = {
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
}

type UsageMetrics = UsageMetricsBase & {
  inputTokens: number
  cacheHitRate: number | null
}

type UsageSeriesEntryBase = UsageMetricsBase & {
  date: string
  models: Record<string, UsageMetricsBase>
}

// Get usage statistics with date range
usageApiRoutes.get("/", (c) => {
  try {
    const accountId = c.req.query("accountId")
    const requestedStartDate = c.req.query("startDate")
    const requestedEndDate = c.req.query("endDate")
    const range = c.req.query("range")
    const month = c.req.query("month")
    const tz = c.req.query("tz")

    const { startMs, endMs, timeZone, startDate, endDate } = resolveDateRange({
      range,
      month,
      startDate: requestedStartDate,
      endDate: requestedEndDate,
      tz,
    })

    const stats = statsStore.getUsageStatsByTimeRange({
      accountId,
      startMs,
      endMs,
      tz: timeZone,
    })

    return c.json({ stats, period: { startDate, endDate, timeZone } })
  } catch (error) {
    recordTraceError(c, error)
    return forwardError(c, error)
  }
})

type PricingTierSource = {
  contextTierAbove?: {
    thresholdTokens: number
    promptPricePer1k: number
    completionPricePer1k: number
    cacheReadPricePer1k: number
    cacheWritePricePer1k: number
  } | null
}

function toExtended(resolved: PricingTierSource): {
  contextThresholdTokens: number | null
  extendedPromptPricePer1k: number | null
  extendedCompletionPricePer1k: number | null
  extendedCacheReadPricePer1k: number | null
  extendedCacheWritePricePer1k: number | null
} {
  return {
    contextThresholdTokens: resolved.contextTierAbove?.thresholdTokens ?? null,
    extendedPromptPricePer1k:
      resolved.contextTierAbove?.promptPricePer1k ?? null,
    extendedCompletionPricePer1k:
      resolved.contextTierAbove?.completionPricePer1k ?? null,
    extendedCacheReadPricePer1k:
      resolved.contextTierAbove?.cacheReadPricePer1k ?? null,
    extendedCacheWritePricePer1k:
      resolved.contextTierAbove?.cacheWritePricePer1k ?? null,
  }
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

// Get model pricing
usageApiRoutes.get("/pricing", (c) => {
  const pricing: Record<
    string,
    {
      promptPricePer1k: number
      completionPricePer1k: number
      cacheReadPricePer1k: number
      cacheWritePricePer1k: number
      contextThresholdTokens: number | null
      extendedPromptPricePer1k: number | null
      extendedCompletionPricePer1k: number | null
      extendedCacheReadPricePer1k: number | null
      extendedCacheWritePricePer1k: number | null
    }
  > = {}
  const sources: Record<
    string,
    "manual" | "models-dev" | "builtin" | "unmatched"
  > = {}

  for (const item of statsStore.getAllModelPricing()) {
    pricing[item.model] = {
      promptPricePer1k: item.promptPricePer1k,
      completionPricePer1k: item.completionPricePer1k,
      cacheReadPricePer1k: item.cacheReadPricePer1k,
      cacheWritePricePer1k: item.cacheWritePricePer1k,
      ...toExtended(item),
    }
    sources[item.model] = "manual"
  }

  if (state.models?.data) {
    const providerHints = buildModelProviderHints()
    for (const model of state.models.data) {
      if (Object.hasOwn(pricing, model.id)) {
        continue
      }
      const resolved = statsStore.resolveModelPricing(
        model.id,
        providerHints.get(model.id),
      )
      if (resolved) {
        pricing[model.id] = {
          promptPricePer1k: resolved.promptPricePer1k,
          completionPricePer1k: resolved.completionPricePer1k,
          cacheReadPricePer1k: resolved.cacheReadPricePer1k,
          cacheWritePricePer1k: resolved.cacheWritePricePer1k,
          ...toExtended(resolved),
        }
        sources[model.id] = resolved.source
        continue
      }
      pricing[model.id] = {
        promptPricePer1k: 0,
        completionPricePer1k: 0,
        cacheReadPricePer1k: 0,
        cacheWritePricePer1k: 0,
        contextThresholdTokens: null,
        extendedPromptPricePer1k: null,
        extendedCompletionPricePer1k: null,
        extendedCacheReadPricePer1k: null,
        extendedCacheWritePricePer1k: null,
      }
      sources[model.id] = "unmatched"
    }
  }

  // Deduplicate pricing entries: a bare model id is redundant when a
  // provider-prefixed version exists. The prefixed id is more specific
  // and should take precedence. We keep the bare id only when it is
  // a manual entry and the prefixed version is not (user may have set
  // the bare-id price intentionally).
  const toRemove = new Set<string>()
  for (const id of Object.keys(pricing)) {
    if (id.includes("/")) continue
    for (const otherId of Object.keys(pricing)) {
      if (otherId === id) continue
      if (!otherId.endsWith(`/${id}`)) continue
      // Bare id is a manual entry but prefixed is not — keep the manual one.
      if (sources[id] === "manual" && sources[otherId] !== "manual") {
        continue
      }
      toRemove.add(id)
      break
    }
  }
  const filteredPricing = Object.fromEntries(
    Object.entries(pricing).filter(([id]) => !toRemove.has(id)),
  )
  const filteredSources = Object.fromEntries(
    Object.entries(sources).filter(([id]) => !toRemove.has(id)),
  )

  return c.json({ pricing: filteredPricing, sources: filteredSources })
})

// Update model pricing
usageApiRoutes.put("/pricing/:model", async (c) => {
  const model = c.req.param("model")
  let body: {
    promptPricePer1k?: number
    completionPricePer1k?: number
    cacheReadPricePer1k?: number
    cacheWritePricePer1k?: number
    contextThresholdTokens?: number | null
    extendedPromptPricePer1k?: number | null
    extendedCompletionPricePer1k?: number | null
    extendedCacheReadPricePer1k?: number | null
    extendedCacheWritePricePer1k?: number | null
  }

  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const existing = statsStore.getModelPricing(model)
  // 阈值区分“字段缺席”（沿用已有分档）与“显式清空”（null/非法值→无分档），
  // 与其他按 `?? existing` 合并的字段保持一致。
  let normalizedThreshold: number | null
  if (body.contextThresholdTokens === undefined) {
    normalizedThreshold = existing?.contextTierAbove?.thresholdTokens ?? null
  } else {
    const parsed = toNullableNumber(body.contextThresholdTokens)
    normalizedThreshold =
      parsed !== null && parsed > 0 ? Math.floor(parsed) : null
  }

  statsStore.setModelPricing(model, {
    promptPricePer1k: body.promptPricePer1k ?? existing?.promptPricePer1k ?? 0,
    completionPricePer1k:
      body.completionPricePer1k ?? existing?.completionPricePer1k ?? 0,
    cacheReadPricePer1k:
      body.cacheReadPricePer1k ?? existing?.cacheReadPricePer1k ?? 0,
    cacheWritePricePer1k:
      body.cacheWritePricePer1k ?? existing?.cacheWritePricePer1k ?? 0,
    contextThresholdTokens: normalizedThreshold,
    extendedPromptPricePer1k:
      toNullableNumber(body.extendedPromptPricePer1k)
      ?? existing?.contextTierAbove?.promptPricePer1k
      ?? null,
    extendedCompletionPricePer1k:
      toNullableNumber(body.extendedCompletionPricePer1k)
      ?? existing?.contextTierAbove?.completionPricePer1k
      ?? null,
    extendedCacheReadPricePer1k:
      toNullableNumber(body.extendedCacheReadPricePer1k)
      ?? existing?.contextTierAbove?.cacheReadPricePer1k
      ?? null,
    extendedCacheWritePricePer1k:
      toNullableNumber(body.extendedCacheWritePricePer1k)
      ?? existing?.contextTierAbove?.cacheWritePricePer1k
      ?? null,
  })

  return c.json({
    pricing: statsStore.getModelPricing(model),
  })
})

// Resolve a date range from query params (days are viewer-timezone days).
// Supported `range` values:
//   - "today"      : today only
//   - "week"       : current ISO-style week (Monday→today)
//   - "month"      : current calendar month (1st → today)
//   - "lastMonth"  : previous calendar month (full)
//   - "last7d"     : rolling 7 days ending today
//   - "last30d"    : rolling 30 days ending today
//   - "all"        : no bounds
// `month=YYYY-MM` selects an arbitrary calendar month and overrides `range`.
// Explicit `startDate`/`endDate` always override.
// `tz` is an IANA timezone name from the browser; day boundaries are UTC
// instants ([startMs, endMs)) in that zone so stats match the viewer's days
// even when the server runs in another timezone.
function resolveDateRange(opts: {
  range?: string
  month?: string
  startDate?: string
  endDate?: string
  tz?: string
}): {
  startDate: string
  endDate: string
  startMs: number
  endMs: number
  timeZone: string
} {
  const timeZone = resolveTimeZone(opts.tz)
  if (opts.startDate && opts.endDate) {
    assertValidDate(opts.startDate, "startDate")
    assertValidDate(opts.endDate, "endDate")
    return withBounds(opts.startDate, opts.endDate, timeZone)
  }

  if (opts.month && /^\d{4}-\d{2}$/.test(opts.month)) {
    const [yearStr, monthStr] = opts.month.split("-")
    const year = Number.parseInt(yearStr, 10)
    const monthIdx = Number.parseInt(monthStr, 10)
    if (monthIdx < 1 || monthIdx > 12) {
      throw new HTTPError(
        `Invalid month "${opts.month}". Expected YYYY-MM with MM in 01-12.`,
        new Response(null, { status: 400 }),
      )
    }
    const start = `${yearStr}-${monthStr}-01`
    const nextMonth =
      monthIdx === 12 ?
        `${year + 1}-01-01`
      : `${yearStr}-${String(monthIdx + 1).padStart(2, "0")}-01`
    return withBounds(start, addDays(nextMonth, -1), timeZone)
  }

  const today = todayInTimeZone(timeZone)
  const range = opts.range ?? "today"

  switch (range) {
    case "today": {
      return withBounds(today, today, timeZone)
    }
    case "week": {
      const weekday = weekdayInTimeZone(today) // 0=Sun..6=Sat
      const offsetToMonday = (weekday + 6) % 7
      return withBounds(addDays(today, -offsetToMonday), today, timeZone)
    }
    case "month": {
      return withBounds(`${today.slice(0, 7)}-01`, today, timeZone)
    }
    case "lastMonth": {
      const year = Number.parseInt(today.slice(0, 4), 10)
      const monthIdx = Number.parseInt(today.slice(5, 7), 10)
      const prevStart =
        monthIdx === 1 ?
          `${year - 1}-12-01`
        : `${year}-${String(monthIdx - 1).padStart(2, "0")}-01`
      return withBounds(
        prevStart,
        addDays(`${today.slice(0, 7)}-01`, -1),
        timeZone,
      )
    }
    case "last7d": {
      return withBounds(addDays(today, -6), today, timeZone)
    }
    case "last30d": {
      return withBounds(addDays(today, -29), today, timeZone)
    }
    case "all": {
      return {
        startDate: "1970-01-01",
        endDate: today,
        startMs: 0,
        endMs: startOfDayMs(addDays(today, 1), timeZone),
        timeZone,
      }
    }
    default: {
      const start = opts.startDate ?? today
      assertValidDate(start, "startDate")
      return withBounds(start, today, timeZone)
    }
  }
}

/** Reject malformed YYYY-MM-DD input before it becomes a NaN bound. */
function assertValidDate(value: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HTTPError(
      `Invalid ${name} "${value}". Expected YYYY-MM-DD.`,
      new Response(null, { status: 400 }),
    )
  }
  const [yearStr, monthStr, dayStr] = value.split("-")
  const year = Number.parseInt(yearStr, 10)
  const month = Number.parseInt(monthStr, 10)
  const day = Number.parseInt(dayStr, 10)
  const roundTrips =
    month >= 1
    && month <= 12
    && day >= 1
    && day <= 31
    && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day
  if (!roundTrips) {
    throw new HTTPError(
      `Invalid ${name} "${value}". Expected a real calendar date.`,
      new Response(null, { status: 400 }),
    )
  }
}

function withBounds(
  startDate: string,
  endDate: string,
  timeZone: string,
): {
  startDate: string
  endDate: string
  startMs: number
  endMs: number
  timeZone: string
} {
  return {
    startDate,
    endDate,
    startMs: startOfDayMs(startDate, timeZone),
    endMs: startOfDayMs(addDays(endDate, 1), timeZone),
    timeZone,
  }
}

function createUsageMetrics(): UsageMetricsBase {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  }
}

function enrichUsageMetrics(metrics: UsageMetricsBase): UsageMetrics {
  const inputTokens = metrics.promptTokens + metrics.cacheReadTokens
  const cacheHitRate =
    inputTokens > 0 ? metrics.cacheReadTokens / inputTokens : null

  return {
    ...metrics,
    inputTokens,
    cacheHitRate,
  }
}

function enrichMetricsMap(
  metricsMap: Record<string, UsageMetricsBase>,
): Record<string, UsageMetrics> {
  const enriched: Record<string, UsageMetrics> = {}
  for (const [key, metrics] of Object.entries(metricsMap)) {
    enriched[key] = enrichUsageMetrics(metrics)
  }
  return enriched
}

function mergeUsageMetrics(
  target: UsageMetricsBase,
  source: UsageMetricsBase,
): void {
  target.requests += source.requests
  target.promptTokens += source.promptTokens
  target.completionTokens += source.completionTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.totalTokens += source.totalTokens
  target.cost += source.cost
}

function createUsageSeriesEntry(date: string): UsageSeriesEntryBase {
  return {
    date,
    ...createUsageMetrics(),
    models: {},
  }
}

function getOrCreateSeriesEntry(
  timeSeriesMap: Record<string, UsageSeriesEntryBase>,
  date: string,
): UsageSeriesEntryBase {
  if (date in timeSeriesMap) {
    return timeSeriesMap[date]
  }

  return createUsageSeriesEntry(date)
}

function getOrCreateMetrics(
  metricsMap: Record<string, UsageMetricsBase>,
  key: string,
): UsageMetricsBase {
  if (key in metricsMap) {
    return metricsMap[key]
  }

  return createUsageMetrics()
}

function aggregateModelUsage(
  target: Record<string, UsageMetricsBase>,
  source: Record<string, UsageMetricsBase>,
): void {
  for (const [model, usage] of Object.entries(source)) {
    const summary = getOrCreateMetrics(target, model)
    mergeUsageMetrics(summary, usage)
    target[model] = summary
  }
}

// Helper: Aggregate usage statistics
function aggregateStats(allStats: ReturnType<typeof statsStore.getUsageStats>) {
  const totals = createUsageMetrics()
  const timeSeriesMap: Record<string, UsageSeriesEntryBase> = {}
  const byModel: Record<string, UsageMetricsBase> = {}

  for (const stat of allStats) {
    mergeUsageMetrics(totals, stat)

    const timeSeriesEntry = getOrCreateSeriesEntry(timeSeriesMap, stat.date)
    timeSeriesMap[stat.date] = timeSeriesEntry
    mergeUsageMetrics(timeSeriesEntry, stat)
    aggregateModelUsage(timeSeriesEntry.models, stat.models)
    aggregateModelUsage(byModel, stat.models)
  }

  const timeSeries = Object.values(timeSeriesMap)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((entry) => ({
      ...enrichUsageMetrics(entry),
      models: enrichMetricsMap(entry.models),
    }))

  return {
    totals: enrichUsageMetrics(totals),
    timeSeries,
    byModel: enrichMetricsMap(byModel),
  }
}

// Helper: Aggregate by account
function aggregateByAccount(range: {
  startMs: number
  endMs: number
  tz: string
}) {
  const byAccount: Record<
    string,
    UsageMetrics & {
      label: string
      models: Record<string, UsageMetrics>
    }
  > = {}

  // 使用 connection 原生列表(替代 listAccounts())
  for (const conn of listAccountManagedConnections()) {
    const accountStats = statsStore.getUsageStatsByTimeRange({
      accountId: conn.id,
      startMs: range.startMs,
      endMs: range.endMs,
      tz: range.tz,
    })
    const totals = createUsageMetrics()
    const models: Record<string, UsageMetricsBase> = {}

    for (const stat of accountStats) {
      mergeUsageMetrics(totals, stat)
      aggregateModelUsage(models, stat.models)
    }

    byAccount[conn.id] = {
      label: conn.name,
      ...enrichUsageMetrics(totals),
      models: enrichMetricsMap(models),
    }
  }

  return byAccount
}

function aggregateByUser(range: {
  startMs: number
  endMs: number
  tz: string
}) {
  const byUser: Record<
    string,
    UsageMetrics & {
      username: string
      models: Record<string, UsageMetrics>
    }
  > = {}

  for (const user of state.users) {
    const userStats = statsStore.getUsageStatsByTimeRange({
      userId: user.id,
      startMs: range.startMs,
      endMs: range.endMs,
      tz: range.tz,
    })
    const totals = createUsageMetrics()
    const models: Record<string, UsageMetricsBase> = {}

    for (const stat of userStats) {
      mergeUsageMetrics(totals, stat)
      aggregateModelUsage(models, stat.models)
    }

    byUser[user.id] = {
      username: user.username,
      ...enrichUsageMetrics(totals),
      models: enrichMetricsMap(models),
    }
  }

  return byUser
}

// Helper: Aggregate by provider (account -> model nested under each provider).
// Reads the persisted `provider` column directly, so usage from deleted
// accounts is still grouped under its provider rather than disappearing.
function aggregateByProvider(range: { startMs: number; endMs: number }) {
  const raw = statsStore.getUsageStatsByProviderInRange({
    startMs: range.startMs,
    endMs: range.endMs,
  })
  const result: Record<
    string,
    UsageMetrics & {
      label: string
      accounts: Record<
        string,
        UsageMetrics & {
          label: string
          deleted?: boolean
          models: Record<string, UsageMetrics>
        }
      >
    }
  > = {}

  for (const [providerId, provider] of Object.entries(raw)) {
    const accounts: Record<
      string,
      UsageMetrics & {
        label: string
        deleted?: boolean
        models: Record<string, UsageMetrics>
      }
    > = {}
    for (const [accountId, account] of Object.entries(provider.accounts)) {
      // "live" check 必须同时覆盖 account-managed connections 和外部 provider
      // connections(plain *-compatible connections)。getProviderConnection 解析
      // 所有 connection,外部 provider 的 usage 不会因此被误标为 deleted。
      const liveConnection = getProviderConnection(accountId)
      accounts[accountId] = {
        // 使用 connection.name 作为 label(替代 getAccount()?.label)
        label: liveConnection?.name ?? accountId,
        ...(liveConnection ? {} : { deleted: true }),
        ...enrichUsageMetrics({
          requests: account.requests,
          promptTokens: account.promptTokens,
          completionTokens: account.completionTokens,
          cacheReadTokens: account.cacheReadTokens,
          cacheWriteTokens: account.cacheWriteTokens,
          totalTokens: account.totalTokens,
          cost: account.cost,
        }),
        models: enrichMetricsMap(account.models),
      }
    }

    result[providerId] = {
      label: providerLabel(providerId),
      ...enrichUsageMetrics({
        requests: provider.requests,
        promptTokens: provider.promptTokens,
        completionTokens: provider.completionTokens,
        cacheReadTokens: provider.cacheReadTokens,
        cacheWriteTokens: provider.cacheWriteTokens,
        totalTokens: provider.totalTokens,
        cost: provider.cost,
      }),
      accounts,
    }
  }

  return result
}

function enrichIntervalSeries(
  series: ReturnType<typeof statsStore.getUsageStatsByInterval> | null,
) {
  if (!series) {
    return null
  }

  return series.map((slot) => ({
    slotTs: slot.slotTs,
    ...enrichUsageMetrics(slot),
    models: enrichMetricsMap(slot.models),
  }))
}

// Get summary statistics
usageApiRoutes.get("/summary", (c) => {
  try {
    const range = c.req.query("range") || "today"
    const month = c.req.query("month")
    const requestedStartDate = c.req.query("startDate")
    const requestedEndDate = c.req.query("endDate")
    const tz = c.req.query("tz")
    const resolved = resolveDateRange({
      range,
      month,
      startDate: requestedStartDate,
      endDate: requestedEndDate,
      tz,
    })
    const { startDate, endDate, startMs, endMs, timeZone } = resolved

    const allStats = statsStore.getUsageStatsByTimeRange({
      startMs,
      endMs,
      tz: timeZone,
    })
    const { totals, timeSeries, byModel } = aggregateStats(allStats)
    const rangeBounds = { startMs, endMs, tz: timeZone }
    const byAccount = aggregateByAccount(rangeBounds)
    const byUser = aggregateByUser(rangeBounds)
    const byProvider = aggregateByProvider(rangeBounds)

    // Only show 15-minute interval breakdown when the range is a single day
    const intervalSeries = enrichIntervalSeries(
      startDate === endDate ?
        statsStore.getUsageStatsByIntervalInRange({
          intervalMinutes: 15,
          startMs,
          endMs,
        })
      : null,
    )

    return c.json({
      totals,
      byAccount,
      byProvider,
      byUser,
      byModel,
      timeSeries,
      intervalSeries,
      period: { startDate, endDate, timeZone },
    })
  } catch (error) {
    recordTraceError(c, error)
    return forwardError(c, error)
  }
})

// Get per-model performance metrics (TTFT, TPS)
usageApiRoutes.get("/performance", (c) => {
  try {
    const range = c.req.query("range") || "today"
    const month = c.req.query("month")
    const requestedStartDate = c.req.query("startDate")
    const requestedEndDate = c.req.query("endDate")
    const tz = c.req.query("tz")
    const { startDate, endDate, startMs, endMs, timeZone } = resolveDateRange({
      range,
      month,
      startDate: requestedStartDate,
      endDate: requestedEndDate,
      tz,
    })

    const performance = statsStore.getPerformanceByModelInRange({
      startMs,
      endMs,
    })

    return c.json({
      performance,
      period: { startDate, endDate, timeZone },
    })
  } catch (error) {
    recordTraceError(c, error)
    return forwardError(c, error)
  }
})
