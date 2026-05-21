import { Hono } from "hono"

import { getDefaultModelPrice } from "~/lib/default-prices"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"

export const usageApiRoutes = new Hono()

type UsageMetrics = {
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
}

type UsageSeriesEntry = UsageMetrics & {
  date: string
  models: Record<string, UsageMetrics>
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
  const pricingArray = statsStore.getAllModelPricing()
  // Convert array to object format for frontend
  const pricing: Record<
    string,
    {
      promptPricePer1k: number
      completionPricePer1k: number
      cacheReadPricePer1k: number
      cacheWritePricePer1k: number
    }
  > = {}

  for (const item of pricingArray) {
    pricing[item.model] = {
      promptPricePer1k: item.promptPricePer1k,
      completionPricePer1k: item.completionPricePer1k,
      cacheReadPricePer1k: item.cacheReadPricePer1k,
      cacheWritePricePer1k: item.cacheWritePricePer1k,
    }
  }

  // Ensure all known models are in the list (even without pricing)
  if (state.models?.data) {
    for (const model of state.models.data) {
      if (!Object.hasOwn(pricing, model.id)) {
        // Use default price if available
        const defaultPrice = getDefaultModelPrice(model.id)
        pricing[model.id] = {
          promptPricePer1k: defaultPrice?.promptPricePer1k ?? 0,
          completionPricePer1k: defaultPrice?.completionPricePer1k ?? 0,
          cacheReadPricePer1k: defaultPrice?.cacheReadPricePer1k ?? 0,
          cacheWritePricePer1k: defaultPrice?.cacheWritePricePer1k ?? 0,
        }
      }
    }
  }

  return c.json({ pricing })
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
  return date.toISOString().split("T")[0] || ""
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
    const start = new Date(Date.UTC(year, monthIdx, 1))
    const end = new Date(Date.UTC(year, monthIdx + 1, 0))
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
      // Current week starting Monday (UTC)
      const day = now.getUTCDay() // 0=Sun..6=Sat
      const offsetToMonday = (day + 6) % 7
      const monday = new Date(now)
      monday.setUTCDate(now.getUTCDate() - offsetToMonday)
      return { startDate: formatDate(monday), endDate: today }
    }
    case "month": {
      // Current calendar month (1st → today)
      const start = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      )
      return { startDate: formatDate(start), endDate: today }
    }
    case "lastMonth": {
      const start = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
      )
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
      return { startDate: formatDate(start), endDate: formatDate(end) }
    }
    case "last7d": {
      const ago = new Date(now)
      ago.setUTCDate(now.getUTCDate() - 6)
      return { startDate: formatDate(ago), endDate: today }
    }
    case "last30d": {
      const ago = new Date(now)
      ago.setUTCDate(now.getUTCDate() - 29)
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

function createUsageMetrics(): UsageMetrics {
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

function mergeUsageMetrics(target: UsageMetrics, source: UsageMetrics): void {
  target.requests += source.requests
  target.promptTokens += source.promptTokens
  target.completionTokens += source.completionTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.totalTokens += source.totalTokens
  target.cost += source.cost
}

function createUsageSeriesEntry(date: string): UsageSeriesEntry {
  return {
    date,
    ...createUsageMetrics(),
    models: {},
  }
}

function getOrCreateSeriesEntry(
  timeSeriesMap: Record<string, UsageSeriesEntry>,
  date: string,
): UsageSeriesEntry {
  if (date in timeSeriesMap) {
    return timeSeriesMap[date]
  }

  return createUsageSeriesEntry(date)
}

function getOrCreateMetrics(
  metricsMap: Record<string, UsageMetrics>,
  key: string,
): UsageMetrics {
  if (key in metricsMap) {
    return metricsMap[key]
  }

  return createUsageMetrics()
}

function aggregateModelUsage(
  target: Record<string, UsageMetrics>,
  source: Record<string, UsageMetrics>,
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
  const timeSeriesMap: Record<string, UsageSeriesEntry> = {}
  const byModel: Record<string, UsageMetrics> = {}

  for (const stat of allStats) {
    mergeUsageMetrics(totals, stat)

    const timeSeriesEntry = getOrCreateSeriesEntry(timeSeriesMap, stat.date)
    timeSeriesMap[stat.date] = timeSeriesEntry
    mergeUsageMetrics(timeSeriesEntry, stat)
    aggregateModelUsage(timeSeriesEntry.models, stat.models)
    aggregateModelUsage(byModel, stat.models)
  }

  const timeSeries = Object.values(timeSeriesMap).sort((a, b) =>
    b.date.localeCompare(a.date),
  )

  return { totals, timeSeries, byModel }
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
    const models: Record<string, UsageMetrics> = {}

    for (const stat of accountStats) {
      mergeUsageMetrics(totals, stat)
      aggregateModelUsage(models, stat.models)
    }

    byAccount[account.id] = {
      label: account.label,
      ...totals,
      models,
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
    const models: Record<string, UsageMetrics> = {}

    for (const stat of userStats) {
      mergeUsageMetrics(totals, stat)
      aggregateModelUsage(models, stat.models)
    }

    byUser[user.id] = {
      username: user.username,
      ...totals,
      models,
    }
  }

  return byUser
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
  const intervalSeries =
    startDate === endDate ?
      statsStore.getUsageStatsByInterval(15, undefined, startDate)
    : null

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
