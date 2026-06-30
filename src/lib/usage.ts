import type { Context } from "hono"

import { canonicalModelId, canonicalNativeModelId } from "~/lib/accounts"
import { logStore } from "~/lib/log-store"
import { logger } from "~/lib/logger"
import { parseModelReference } from "~/lib/route-target/model-reference"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { incrementUserTokens } from "~/lib/users"

/** Map request model id to the account catalog public id when possible. */
export function resolveUsageModelId(accountId: string, model: string): string {
  const account = state.accounts.find((entry) => entry.id === accountId)
  if (!account) return model

  const native = canonicalNativeModelId(
    parseModelReference(model, account).nativeModelId,
  )
  const matched = account.availableModels?.find(
    (entry) => canonicalNativeModelId(entry.id) === native,
  )
  if (matched) return matched.id

  return canonicalModelId(model, account)
}

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
  ttftMs?: number
  tps?: number
  streaming?: boolean
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
    ttftMs,
    tps,
    streaming,
  } = input

  void trackUserTokenUsage(c, totalTokens)

  try {
    const now = timestamp ?? Date.now()
    const usageModel = resolveUsageModelId(accountId, model)
    const pricing = statsStore.getModelPricing(usageModel)
    const cost =
      pricing ?
        (promptTokens / 1000) * pricing.promptPricePer1k
        + (completionTokens / 1000) * pricing.completionPricePer1k
        + (cacheReadTokens / 1000) * pricing.cacheReadPricePer1k
        + (cacheWriteTokens / 1000) * pricing.cacheWritePricePer1k
      : 0

    statsStore.recordUsage({
      date: statsStore.getDateString(now),
      accountId,
      userId: c.get("userId"),
      model: usageModel,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      timestamp: now,
      ttftMs,
      tps,
      streaming,
    })
    logStore.push({
      timestamp: now,
      level: "info",
      message: `Usage recorded for ${usageModel}`,
      userId: c.get("userId"),
      username: c.get("username"),
      accountId,
      model: usageModel,
      promptTokens,
      completionTokens,
      path: c.req.path,
      statusCode: c.res.status,
      ttftMs,
      generationTps: tps,
      streaming,
    })
    // logger.info(
    //   `Token usage: ${promptTokens} in + ${completionTokens} out = ${totalTokens} total (model: ${usageModel})${cacheReadTokens > 0 ? `, cache read: ${cacheReadTokens} (${Math.round((cacheReadTokens / (promptTokens + cacheReadTokens)) * 100)}%)` : ""}`,
    // )
  } catch (error) {
    logger.warn("Failed to record usage:", error)
  }
}

async function trackUserTokenUsage(c: Context, tokens: number): Promise<void> {
  if (tokens <= 0) {
    return
  }

  const userId = c.get("userId")
  if (!userId) {
    return
  }

  try {
    await incrementUserTokens(userId, tokens)
    logger.debug(`Tracked ${tokens} tokens for user ${userId}`)
  } catch (error) {
    logger.warn("Failed to track user token usage:", error)
  }
}
