import { Hono } from "hono"

import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"

export const usageApiRoutes = new Hono()

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
  const accountId = c.req.query("accountId")
  const requestedStartDate = c.req.query("startDate")
  const requestedEndDate = c.req.query("endDate")
  const range = c.req.query("range")
  const month = c.req.query("month")

  const { startDate, endDate } = resolveDateRange({
    range,
    month,
    startDate: requestedStartDate,
    endDate: requestedEndDate,
  })

  const stats = statsStore.getUsageStats(accountId, startDate, endDate)

  return c.json({ stats, period: { startDate, endDate } })
})

// Get model pricing
usageApiRoutes.get("/pricing", (c) => {
  const pricing: Record<
    string,
    {
      promptPricePer1k: number
      completionPricePer1k: number
      cacheReadPricePer1k: number
      cacheWritePricePer1k: number
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
    }
    sources[item.model] = "manual"
  }

  if (state.models?.data) {
    for (const model of state.models.data) {
      if (Object.hasOwn(pricing, model.id)) {
        continue
      }
      const resolved = statsStore.resolveModelPricing(model.id)
      if (resolved) {
        pricing[model.id] = {
          promptPricePer1k: resolved.promptPricePer1k,
          completionPricePer1k: resolved.completionPricePer1k,
          cacheReadPricePer1k: resolved.cacheReadPricePer1k,
          cacheWritePricePer1k: resolved.cacheWritePricePer1k,
        }
        sources[model.id] = resolved.source
        continue
      }
      pricing[model.id] = {
        promptPricePer1k: 0,
        completionPricePer1k: 0,
        cacheReadPricePer1k: 0,
        cacheWritePricePer1k: 0,
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
  }

  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const existing = statsStore.getModelPricing(model)
  statsStore.setModelPricing(model, {
    promptPricePer1k: body.promptPricePer1k ?? existing?.promptPricePer1k ?? 0,
    completionPricePer1k:
      body.completionPricePer1k ?? existing?.completionPricePer1k ?? 0,
    cacheReadPricePer1k:
      body.cacheReadPricePer1k ?? existing?.cacheReadPricePer1k ?? 0,
    cacheWritePricePer1k:
      body.cacheWritePricePer1k ?? existing?.cacheWritePricePer1k ?? 0,
  })

  return c.json({
    pricing: statsStore.getModelPricing(model),
  })
})

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

// Resolve a date range from query params.
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
function resolveDateRange(opts: {
  range?: string
  month?: string
  startDate?: string
  endDate?: string
}): { startDate: string; endDate: string } {
  if (opts.startDate && opts.endDate) {
    return { startDate: opts.startDate, endDate: opts.endDate }
  }

  if (opts.month && /^\d{4}-\d{2}$/.test(opts.month)) {
    const [yearStr, monthStr] = opts.month.split("-")
    const year = Number.parseInt(yearStr, 10)
    const monthIdx = Number.parseInt(monthStr, 10) - 1
    const start = new Date(year, monthIdx, 1)
    const end = new Date(year, monthIdx + 1, 0)
    return { startDate: formatDate(start), endDate: formatDate(end) }
  }

  const now = new Date()
  const today = formatDate(now)
  const range = opts.range ?? "today"

  switch (range) {
    case "today": {
      return { startDate: today, endDate: today }
    }
    case "week": {
      const day = now.getDay() // 0=Sun..6=Sat
      const offsetToMonday = (day + 6) % 7
      const monday = new Date(now)
      monday.setDate(now.getDate() - offsetToMonday)
      return { startDate: formatDate(monday), endDate: today }
    }
    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { startDate: formatDate(start), endDate: today }
    }
    case "lastMonth": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 0)
      return { startDate: formatDate(start), endDate: formatDate(end) }
    }
    case "last7d": {
      const ago = new Date(now)
      ago.setDate(now.getDate() - 6)
      return { startDate: formatDate(ago), endDate: today }
    }
    case "last30d": {
      const ago = new Date(now)
      ago.setDate(now.getDate() - 29)
      return { startDate: formatDate(ago), endDate: today }
    }
    case "all": {
      return { startDate: "1970-01-01", endDate: today }
    }
    default: {
      return { startDate: opts.startDate ?? today, endDate: today }
    }
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
function aggregateByAccount(startDate: string, endDate: string) {
  const byAccount: Record<
    string,
    UsageMetrics & {
      label: string
      models: Record<string, UsageMetrics>
    }
  > = {}

  for (const account of state.accounts) {
    const accountStats = statsStore.getUsageStats(
      account.id,
      startDate,
      endDate,
    )
    const totals = createUsageMetrics()
    const models: Record<string, UsageMetricsBase> = {}

    for (const stat of accountStats) {
      mergeUsageMetrics(totals, stat)
      aggregateModelUsage(models, stat.models)
    }

    byAccount[account.id] = {
      label: account.label,
      ...enrichUsageMetrics(totals),
      models: enrichMetricsMap(models),
    }
  }

  return byAccount
}

function aggregateByUser(startDate: string, endDate: string) {
  const byUser: Record<
    string,
    UsageMetrics & {
      username: string
      models: Record<string, UsageMetrics>
    }
  > = {}

  for (const user of state.users) {
    const userStats = statsStore.getUsageStatsForUser(
      user.id,
      startDate,
      endDate,
    )
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
  const range = c.req.query("range") || "today"
  const month = c.req.query("month")
  const requestedStartDate = c.req.query("startDate")
  const requestedEndDate = c.req.query("endDate")
  const { startDate, endDate } = resolveDateRange({
    range,
    month,
    startDate: requestedStartDate,
    endDate: requestedEndDate,
  })

  const allStats = statsStore.getUsageStats(undefined, startDate, endDate)
  const { totals, timeSeries, byModel } = aggregateStats(allStats)
  const byAccount = aggregateByAccount(startDate, endDate)
  const byUser = aggregateByUser(startDate, endDate)

  // Only show 15-minute interval breakdown when the range is a single day
  const intervalSeries = enrichIntervalSeries(
    startDate === endDate ?
      statsStore.getUsageStatsByInterval(15, undefined, startDate)
    : null,
  )

  return c.json({
    totals,
    byAccount,
    byUser,
    byModel,
    timeSeries,
    intervalSeries,
    period: { startDate, endDate },
  })
})

// Get per-model performance metrics (TTFT, TPS)
usageApiRoutes.get("/performance", (c) => {
  const range = c.req.query("range") || "today"
  const month = c.req.query("month")
  const requestedStartDate = c.req.query("startDate")
  const requestedEndDate = c.req.query("endDate")
  const { startDate, endDate } = resolveDateRange({
    range,
    month,
    startDate: requestedStartDate,
    endDate: requestedEndDate,
  })

  const performance = statsStore.getPerformanceByModel(startDate, endDate)

  return c.json({
    performance,
    period: { startDate, endDate },
  })
})
