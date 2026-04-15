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
  const startDate = c.req.query("startDate")
  const endDate = c.req.query("endDate")
  const range = c.req.query("range")

  // Predefined ranges
  let effectiveStart = startDate
  let effectiveEnd = endDate

  switch (range) {
    case "week": {
      const now = new Date()
      const weekAgo = new Date(now)
      weekAgo.setDate(weekAgo.getDate() - 7)
      effectiveStart = formatDate(weekAgo)
      effectiveEnd = formatDate(now)

      break
    }
    case "month": {
      const now = new Date()
      const monthAgo = new Date(now)
      monthAgo.setMonth(monthAgo.getMonth() - 1)
      effectiveStart = formatDate(monthAgo)
      effectiveEnd = formatDate(now)

      break
    }
    case "today": {
      const now = new Date()
      effectiveStart = formatDate(now)
      effectiveEnd = effectiveStart

      break
    }
    // No default
  }

  const stats = statsStore.getUsageStats(
    accountId,
    effectiveStart,
    effectiveEnd,
  )

  return c.json({ stats })
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

// Helper: Get date range from query
function getDateRange(
  range: string,
  startDate?: string,
  endDate?: string,
): { startDate: string; endDate: string } {
  if (startDate && endDate) {
    return { startDate, endDate }
  }

  const now = new Date()
  const resolvedEndDate = endDate || formatDate(now)
  let resolvedStartDate = startDate || resolvedEndDate

  switch (range) {
    case "week": {
      const weekAgo = new Date(now)
      weekAgo.setDate(weekAgo.getDate() - 7)
      resolvedStartDate = startDate || formatDate(weekAgo)
      break
    }
    case "month": {
      const monthAgo = new Date(now)
      monthAgo.setMonth(monthAgo.getMonth() - 1)
      resolvedStartDate = startDate || formatDate(monthAgo)
      break
    }
    default:
  }

  return { startDate: resolvedStartDate, endDate: resolvedEndDate }
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

// Get summary statistics
usageApiRoutes.get("/summary", (c) => {
  const range = c.req.query("range") || "today"
  const requestedStartDate = c.req.query("startDate")
  const requestedEndDate = c.req.query("endDate")
  const { startDate, endDate } = getDateRange(
    range,
    requestedStartDate,
    requestedEndDate,
  )

  const allStats = statsStore.getUsageStats(undefined, startDate, endDate)
  const { totals, timeSeries, byModel } = aggregateStats(allStats)
  const byAccount = aggregateByAccount(startDate, endDate)

  const intervalSeries =
    range === "today" ?
      statsStore.getUsageStatsByInterval(15, undefined, startDate)
    : null

  return c.json({
    totals,
    byAccount,
    byModel,
    timeSeries,
    intervalSeries,
    period: { startDate, endDate },
  })
})
