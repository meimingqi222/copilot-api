import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"

import { logger } from "~/lib/logger"
import { resolveModelAlias } from "~/lib/model-aliases"
import { calculateModelCost } from "~/lib/models-dev"
import { isProviderId } from "~/lib/provider-config"
import {
  connectionProvider,
  getProviderConnection,
  isAccountManagedConnection,
} from "~/lib/provider-connections"
import { getRequestLogContext, patchRequestLog } from "~/lib/request-log"
import { parseGroupReference, splitMember } from "~/lib/routing-groups/resolve"
import { noteSessionAffinityCacheRead } from "~/lib/routing"
import { recordServedTokens } from "~/lib/route-target"
import {
  canonicalModelId,
  canonicalNativeModelId,
  parseModelReference,
  resolveModelRouting,
} from "~/lib/route-target/model-reference"
import { statsStore } from "~/lib/stats-store"
import { takeUsagePricingRounds } from "~/lib/usage-pricing-rounds"
import { codexServiceTierCostMultiplier } from "~/lib/stats/service-tier-pricing"
import { requestPerformanceSnapshot } from "~/lib/request-performance"
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

interface UsageRecordInput {
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

/** A group is a routing name; accounting follows the final responding model. */
function resolveGroupUsageModel(
  c: Context,
  accountId: string,
  requested: string,
): { model: string; upstream?: string } {
  if (parseGroupReference(requested) === undefined) return { model: requested }
  const entry = getRequestLogContext(c)?.entry
  if (entry?.connectionId !== accountId) return { model: requested }
  const upstream = entry.modelUpstream?.trim()
  const selected = entry.routingGroupSelectedMember
  if (!upstream) {
    const model =
      selected ?
        resolveModelRouting(splitMember(selected).model).modelId
      : requested
    return { model }
  }
  const connection = getProviderConnection(accountId)
  const mappings =
    connection?.models?.filter(
      (model) => model.upstreamId.toLowerCase() === upstream.toLowerCase(),
    ) ?? []
  const selectedModel =
    selected ?
      resolveModelRouting(splitMember(selected).model).modelId
    : undefined
  const mapping =
    mappings.find((model) => model.publicId === selectedModel) ?? mappings[0]
  return { model: mapping?.publicId ?? upstream, upstream }
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
    const actual = resolveGroupUsageModel(c, accountId, model)
    const usageModel = resolveUsageModelId(accountId, actual.model)
    // 用 connection 原生派生 provider（metadata.provider 优先）。
    // 注意：codebuddy / codebuddy-cn 共用 codebuddy-native 协议，
    // 不能用 providerFromProtocol（后写覆盖，永远得到 codebuddy-cn）。
    const conn = getProviderConnection(accountId)
    const provider =
      explicitProvider
      ?? (conn ? connectionProvider(conn) : undefined)
      ?? (c.get("provider") as string | undefined)
      ?? "unknown"
    const resolvedConnectionId =
      connectionId ?? (c.get("connectionId") as string | undefined)
    const resolvedCredentialId =
      credentialId ?? (c.get("credentialId") as string | undefined)
    const providerHint = isProviderId(provider) ? provider : undefined
    const pricing =
      statsStore.getModelPricing(usageModel, providerHint)
      ?? (actual.upstream ?
        statsStore.getModelPricing(actual.upstream, providerHint)
      : null)
    const pricingRounds = takeUsagePricingRounds(c, accountId) ?? [
      {
        promptTokens,
        completionTokens,
        cacheReadTokens,
        cacheWriteTokens,
      },
    ]
    const cost =
      pricing ?
        pricingRounds.reduce(
          (sum, tokens) => sum + calculateModelCost(pricing, tokens),
          0,
        )
        * codexServiceTierCostMultiplier(
          provider,
          accountId,
          getRequestLogContext(c)?.entry,
        )
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
      performance: requestPerformanceSnapshot(c, streaming),
    })
    if (resolvedConnectionId && resolvedCredentialId) {
      recordServedTokens(
        resolvedConnectionId,
        resolvedCredentialId,
        completionTokens,
      )
      // Phase 4: record how much the vendor's prompt cache served, so the
      // `auto` affinity mode can decide whether sticking is worth it.
      noteSessionAffinityCacheRead(
        `${resolvedConnectionId}::${resolvedCredentialId}`,
        cacheReadTokens,
      )
    }
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
