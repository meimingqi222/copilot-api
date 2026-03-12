import { Hono } from "hono"

import { getDefaultModelPrice } from "~/lib/default-prices"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"

export const usageApiRoutes = new Hono()

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
      effectiveStart = weekAgo.toISOString().split("T")[0] ?? ""
      effectiveEnd = now.toISOString().split("T")[0] ?? ""

      break
    }
    case "month": {
      const now = new Date()
      const monthAgo = new Date(now)
      monthAgo.setMonth(monthAgo.getMonth() - 1)
      effectiveStart = monthAgo.toISOString().split("T")[0] ?? ""
      effectiveEnd = now.toISOString().split("T")[0] ?? ""

      break
    }
    case "today": {
      const now = new Date()
      effectiveStart = now.toISOString().split("T")[0] ?? ""
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

// Get summary statistics
usageApiRoutes.get("/summary", (c) => {
  const range = c.req.query("range") || "today"

  const now = new Date()
  let startDate: string
  const endDate = now.toISOString().split("T")[0] ?? ""

  switch (range) {
    case "today": {
      startDate = endDate

      break
    }
    case "week": {
      const weekAgo = new Date(now)
      weekAgo.setDate(weekAgo.getDate() - 7)
      startDate = weekAgo.toISOString().split("T")[0] ?? ""

      break
    }
    case "month": {
      const monthAgo = new Date(now)
      monthAgo.setMonth(monthAgo.getMonth() - 1)
      startDate = monthAgo.toISOString().split("T")[0] ?? ""

      break
    }
    default: {
      startDate = endDate
    }
  }

  const allStats = statsStore.getUsageStats(undefined, startDate, endDate)

  // Aggregate totals
  const totals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  }

  const byAccount: Record<
    string,
    {
      label: string
      requests: number
      promptTokens: number
      completionTokens: number
      totalTokens: number
      cost: number
    }
  > = {}

  const byModel: Record<string, { tokens: number; cost: number }> = {}

  for (const stat of allStats) {
    totals.requests += stat.requests
    totals.promptTokens += stat.promptTokens
    totals.completionTokens += stat.completionTokens
    totals.cacheReadTokens += stat.cacheReadTokens
    totals.cacheWriteTokens += stat.cacheWriteTokens
    totals.totalTokens += stat.totalTokens
    totals.cost += stat.cost

    // Aggregate by model
    for (const [model, usage] of Object.entries(stat.models)) {
      if (!Object.hasOwn(byModel, model)) {
        byModel[model] = { tokens: 0, cost: 0 }
      }
      byModel[model].tokens += usage.tokens
      byModel[model].cost += usage.cost
    }
  }

  // Aggregate by account
  for (const account of state.accounts) {
    const accountStats = statsStore.getUsageStats(
      account.id,
      startDate,
      endDate,
    )
    byAccount[account.id] = {
      label: account.label,
      requests: accountStats.reduce((sum, s) => sum + s.requests, 0),
      promptTokens: accountStats.reduce((sum, s) => sum + s.promptTokens, 0),
      completionTokens: accountStats.reduce(
        (sum, s) => sum + s.completionTokens,
        0,
      ),
      totalTokens: accountStats.reduce((sum, s) => sum + s.totalTokens, 0),
      cost: accountStats.reduce((sum, s) => sum + s.cost, 0),
    }
  }

  return c.json({
    totals,
    byAccount,
    byModel,
    period: { startDate, endDate },
  })
})
