import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"

import { logger } from "~/lib/logger"
import { resolveModelAlias } from "~/lib/model-aliases"
import { isProviderId } from "~/lib/provider-config"
import {
  connectionProvider,
  getProviderConnection,
  isAccountManagedConnection,
  providerFromProtocol,
} from "~/lib/provider-connections"
import { patchRequestLog } from "~/lib/request-log"
import {
  canonicalModelId,
  canonicalNativeModelId,
  parseModelReference,
} from "~/lib/route-target/model-reference"
import { statsStore } from "~/lib/stats-store"
import { incrementUserTokens } from "~/lib/users"

/** Map request model id to the account catalog public id when possible. */
export function resolveUsageModelId(accountId: string, model: string): string {
  // 用 connection 字段直接判断（替代原 getAccount 路径）
  const conn = getProviderConnection(accountId)
  if (!conn || !isAccountManagedConnection(conn)) {
    // 没有 account-managed connection 时也解析别名，以便用真实 model id 查询定价
    return resolveModelAlias(model, accountId).resolvedModelId
  }

  const native = canonicalNativeModelId(
    parseModelReference(model, conn.modelPrefix).nativeModelId,
  )
  // 解析模型别名：将客户端请求的别名映射到真实 model id，
  // 确保用量统计和定价查询使用真实模型而非别名
  const resolvedModel = resolveModelAlias(native, accountId).resolvedModelId

  const matched = conn.models?.find(
    (entry) => canonicalNativeModelId(entry.publicId) === resolvedModel,
  )
  if (matched) return matched.publicId

  return canonicalModelId(resolvedModel, conn.modelPrefix)
}

export function identityFromAdmission(
  admission: RequestAdmission,
): UsageIdentity {
  return {
    ownerId: admission.connection.id,
    connectionId: admission.target.connectionId,
    credentialId: admission.target.credentialId,
    provider: connectionProvider(admission.connection),
  }
}

export interface UsageIdentity {
  ownerId: string
  connectionId: string
  credentialId: string
  provider: string
}

export function applyUsageIdentity(c: Context, identity: UsageIdentity): void {
  c.set("accountId", identity.ownerId)
  c.set("provider", identity.provider)
  c.set("connectionId", identity.connectionId)
  c.set("credentialId", identity.credentialId)
}

export interface UsageRecordInput {
  c: Context
  accountId: string
  provider?: string
  connectionId?: string
  credentialId?: string
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
  finishReason?: string
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
    finishReason,
    provider: explicitProvider,
    connectionId,
    credentialId,
  } = input

  void trackUserTokenUsage(c, totalTokens)

  try {
    const now = timestamp ?? Date.now()
    const usageModel = resolveUsageModelId(accountId, model)
    // 用 connection 字段直接派生 provider（替代原 getAccount(accountId)?.provider）
    const conn = getProviderConnection(accountId)
    const provider =
      explicitProvider
      ?? (conn ? providerFromProtocol(conn.protocol) : undefined)
      ?? (c.get("provider") as string | undefined)
      ?? "unknown"
    const resolvedConnectionId =
      connectionId ?? (c.get("connectionId") as string | undefined)
    const resolvedCredentialId =
      credentialId ?? (c.get("credentialId") as string | undefined)
    const pricing = statsStore.getModelPricing(
      usageModel,
      isProviderId(provider) ? provider : undefined,
    )
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
      connectionId: resolvedConnectionId,
      credentialId: resolvedCredentialId,
      userId: c.get("userId"),
      model: usageModel,
      provider,
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
    patchRequestLog(c, {
      model: usageModel,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ttftMs,
      generationTps: tps,
      streaming,
      finishReason,
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
