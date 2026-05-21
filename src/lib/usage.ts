import type { Context } from "hono"

import consola from "consola"

import { logStore } from "~/lib/log-store"
import { statsStore } from "~/lib/stats-store"
import { incrementUserTokens } from "~/lib/users"

export interface UsageRecordInput {
  c: Context
  accountId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  timestamp?: number
}

export function recordUsage(input: UsageRecordInput): void {
  const {
    c,
    accountId,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    timestamp,
  } = input

  void trackUserTokenUsage(c, totalTokens)

  try {
    const now = timestamp ?? Date.now()
    const pricing = statsStore.getModelPricing(model)
    const cost =
      pricing ?
        (promptTokens / 1000) * pricing.promptPricePer1k
        + (completionTokens / 1000) * pricing.completionPricePer1k
        + (cacheReadTokens / 1000) * pricing.cacheReadPricePer1k
        + (cacheWriteTokens / 1000) * pricing.cacheWritePricePer1k
      : 0

    statsStore.recordUsage({
      date: new Date(now).toISOString().split("T")[0] ?? "",
      accountId,
      userId: c.get("userId" as never) as string | undefined,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      timestamp: now,
    })
    logStore.push({
      timestamp: now,
      level: "info",
      message: `Usage recorded for ${model}`,
      userId: c.get("userId" as never) as string | undefined,
      username: c.get("username" as never) as string | undefined,
      accountId,
      model,
      promptTokens,
      completionTokens,
      path: c.req.path,
      statusCode: c.res.status,
    })
    consola.debug(
      `Recorded usage: ${model} - ${totalTokens} tokens ($${cost.toFixed(4)})`,
    )
  } catch (error) {
    consola.warn("Failed to record usage:", error)
  }
}

async function trackUserTokenUsage(c: Context, tokens: number): Promise<void> {
  if (tokens <= 0) {
    return
  }

  const userId = c.get("userId" as never) as string | undefined
  if (!userId) {
    return
  }

  try {
    await incrementUserTokens(userId, tokens)
    consola.debug(`Tracked ${tokens} tokens for user ${userId}`)
  } catch (error) {
    consola.warn("Failed to track user token usage:", error)
  }
}
