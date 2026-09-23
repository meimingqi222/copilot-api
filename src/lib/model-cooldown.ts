/**
 * 模型级冷却（model-scoped cooldown）内存存储。
 *
 * 背景：CodeBuddy 上游对部分模型返回模型级限流（业务码 6004），语义是
 * “该模型在此账号上暂时超限，切其它模型立即可用”。账号级冷却会把同账号
 * 的健康模型一并晾起，因此需要 (credential, model) 粒度的冷却。
 *
 * 设计约束：
 * - 通用机制、按调用方 opt-in：其它 provider 沿用账号级冷却，不受影响。
 * - 纯内存（与 adaptive limiter 一致）：冷却本就是瞬态（分钟～小时级），
 *   重启丢失最多导致一次额外的上游 429，自愈；避免持久化 schema 变更。
 * - 惰性过期：读时发现过期即删，无定时器。
 */

import { logger } from "~/lib/logger"

interface ModelCooldownEntry {
  connectionId: string
  untilMs: number
  reason?: string
}

const modelCooldowns = new Map<string, ModelCooldownEntry>()

export function normalizeModelCooldownKey(model: string): string {
  return model.trim().toLowerCase()
}

function entryKey(credentialId: string, model: string): string {
  return `${credentialId}::${normalizeModelCooldownKey(model)}`
}

export interface RecordModelCooldownInput {
  credentialId: string
  connectionId: string
  model: string
  untilMs: number
  reason?: string
}

/**
 * 记录 (credential, model) 冷却。已存在的条目按 untilMs 取最晚（幂等，
 * adapter 与 dispatch 双路落库不会互相覆盖出更短的冷却）。
 */
export function recordModelCooldown(input: RecordModelCooldownInput): void {
  const { credentialId, connectionId, model, untilMs, reason } = input
  if (!credentialId || !model || !(untilMs > Date.now())) return
  const key = entryKey(credentialId, model)
  const existing = modelCooldowns.get(key)
  if (existing && existing.untilMs >= untilMs) return
  modelCooldowns.set(key, { connectionId, untilMs, reason })
  logger.warn(
    `[model-cooldown] credential ${credentialId} model "${normalizeModelCooldownKey(model)}" cooling until ${new Date(untilMs).toISOString()} reason=${reason ?? "unknown"}`,
  )
}

/** 剩余冷却毫秒数；无条目或已过期返回 0（过期条目惰性删除）。 */
export function getModelCooldownRemainingMs(
  credentialId: string,
  model: string,
): number {
  const key = entryKey(credentialId, model)
  const entry = modelCooldowns.get(key)
  if (!entry) return 0
  const remaining = entry.untilMs - Date.now()
  if (remaining <= 0) {
    modelCooldowns.delete(key)
    return 0
  }
  return remaining
}

export function isModelCoolingDown(
  credentialId: string,
  model: string,
): boolean {
  return getModelCooldownRemainingMs(credentialId, model) > 0
}

/** 清除某 connection 名下全部模型冷却（账号删除/限流状态清理时调用）。 */
export function clearModelCooldownsForConnection(connectionId: string): void {
  for (const [key, entry] of modelCooldowns) {
    if (entry.connectionId === connectionId) {
      modelCooldowns.delete(key)
    }
  }
}

export interface ModelCooldownInfo {
  /** 归一化后的模型 id（小写）。 */
  model: string
  credentialId: string
  /** 恢复前剩余秒数（诊断/展示用）。 */
  retryAfterSeconds: number
  reason?: string
}

/**
 * 列出某 connection 名下仍在生效的模型冷却（管理面台账用）。
 * 过期条目惰性删除；按剩余时间升序（最先恢复的在前）。
 */
export function listModelCooldownsForConnection(
  connectionId: string,
): Array<ModelCooldownInfo> {
  const now = Date.now()
  const out: Array<ModelCooldownInfo> = []
  for (const [key, entry] of modelCooldowns) {
    if (entry.connectionId !== connectionId) continue
    const remaining = entry.untilMs - now
    if (remaining <= 0) {
      modelCooldowns.delete(key)
      continue
    }
    const separator = key.lastIndexOf("::")
    out.push({
      model: separator >= 0 ? key.slice(separator + 2) : key,
      credentialId: key.slice(0, separator),
      retryAfterSeconds: Math.ceil(remaining / 1000),
      reason: entry.reason,
    })
  }
  out.sort((a, b) => a.retryAfterSeconds - b.retryAfterSeconds)
  return out
}

export function resetModelCooldownsForTest(): void {
  modelCooldowns.clear()
}
