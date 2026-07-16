/**
 * Provider Connection 状态机辅助函数。
 *
 * 负责:
 * - 自动从 cooldown / quota_exhausted 状态恢复(基于时间窗口)。
 * - 根据上游错误把 credential 置入合适的失效状态。
 * - 判断 credential / connection 是否可参与调度。
 */

import { logger } from "~/lib/logger"
import { parseRetryAfterMs } from "~/lib/retry-after"

import type { ApiCredential, ProviderConnection } from "./types"

import { DEFAULTS } from "./types"

/**
 * 把过期的 cooldown / 长期 quota_exhausted 自动恢复为 ready。
 *
 * 修复:当 cooldownUntil === undefined 但 status 仍为 cooldown/quota_exhausted
 * 时也恢复为 ready。这处理了 normalizeConnectionRuntimeFields 清除
 * cooldownUntil 但不重置 status 的历史 bug,以及从磁盘加载时
 * cooldownUntil 丢失的边缘情况。如果上游仍处于限额状态,
 * 下次请求会重新标记 credential。
 */
export function refreshCredentialAvailability(
  credential: ApiCredential,
  now: number = Date.now(),
): void {
  if (
    credential.status === "cooldown"
    && (credential.cooldownUntil === undefined
      || credential.cooldownUntil <= now)
  ) {
    credential.status = "ready"
    credential.cooldownUntil = undefined
  }

  if (
    credential.status === "quota_exhausted"
    && (credential.cooldownUntil === undefined
      || credential.cooldownUntil <= now)
  ) {
    credential.status = "ready"
    credential.cooldownUntil = undefined
  }
}

export function refreshConnectionAvailability(
  connection: ProviderConnection,
  now: number = Date.now(),
): void {
  const credentials = connection.credentials
  if (!Array.isArray(credentials)) return
  for (const credential of credentials) {
    refreshCredentialAvailability(credential, now)
  }
}

/** Credential 是否当前可调度。 */
export function isCredentialAvailable(credential: ApiCredential): boolean {
  if (!credential.enabled) return false
  if (credential.status !== "ready") return false
  return true
}

export function isConnectionAvailable(connection: ProviderConnection): boolean {
  if (!connection.enabled) return false
  return connection.credentials.some((c) => isCredentialAvailable(c))
}

export interface RateLimitInfo {
  /** `Retry-After` 头解析出的秒数,或上游建议的下次重试时间。 */
  retryAfterMs?: number
  reason?: string
}

/** 把 credential 标记为短期冷却(429 / 5xx / 网络错误)。 */
export function markCredentialCooldown(
  credential: ApiCredential,
  info: RateLimitInfo = {},
): void {
  const now = Date.now()
  const cooldownMs =
    info.retryAfterMs && info.retryAfterMs > 0 ?
      info.retryAfterMs
    : DEFAULTS.COOLDOWN_429_FALLBACK_MS
  credential.status = "cooldown"
  credential.cooldownUntil = now + cooldownMs
  credential.lastRateLimitAt = now
  credential.lastError = info.reason
  credential.lastErrorAt = now
  logger.warn(
    `[provider-connections] credential ${credential.id} cooldown for ${cooldownMs}ms reason=${
      info.reason ?? "unknown"
    }`,
  )
}

/** 鉴权错误(401/403),需要手动重置。 */
export function markCredentialAuthError(
  credential: ApiCredential,
  reason?: string,
): void {
  const now = Date.now()
  credential.status = "auth_error"
  credential.lastError = reason
  credential.lastErrorAt = now
  logger.warn(
    `[provider-connections] credential ${credential.id} auth_error reason=${
      reason ?? "unknown"
    }`,
  )
}

/** 余额/配额耗尽。默认配置长冷却后自动恢复。 */
export function markCredentialQuotaExhausted(
  credential: ApiCredential,
  reason?: string,
  recoveryMs: number = DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS,
): void {
  const now = Date.now()
  credential.status = "quota_exhausted"
  credential.cooldownUntil = now + recoveryMs
  credential.lastError = reason
  credential.lastErrorAt = now
  logger.warn(
    `[provider-connections] credential ${credential.id} quota_exhausted reason=${
      reason ?? "unknown"
    }`,
  )
}

/** 手动重置 credential 状态。 */
export function resetCredentialStatus(credential: ApiCredential): void {
  credential.status = credential.enabled ? "ready" : "disabled"
  credential.cooldownUntil = undefined
  credential.lastError = undefined
  credential.lastErrorAt = undefined
  credential.lastRateLimitAt = undefined
}

export function setCredentialEnabled(
  credential: ApiCredential,
  enabled: boolean,
): void {
  credential.enabled = enabled
  if (!enabled) {
    credential.status = "disabled"
  } else if (credential.status === "disabled") {
    credential.status = "ready"
  }
}

/**
 * 根据上游 HTTP 响应分类错误并更新状态。
 * 返回错误类别供调用方决定是否 failover。
 */
export type UpstreamErrorKind =
  | "rate_limited"
  | "auth_error"
  | "quota_exhausted"
  | "server_error"
  | "client_error"
  | "network_error"
  | "unknown"

export function classifyUpstreamError(input: {
  status?: number
  retryAfterHeader?: string | null
  body?: string
}): { kind: UpstreamErrorKind; retryAfterMs?: number } {
  const { status, body } = input
  const retryAfterMs = parseRetryAfterMs(
    input.retryAfterHeader,
    DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS,
  )

  if (status === undefined) {
    return { kind: "network_error" }
  }

  // Codex returns 429 with error.type == "usage_limit_reached" when a
  // credential's plan quota is depleted. This is distinct from transient
  // per-minute rate limits (rate_limit_error/rate_limit_exceeded) and
  // carries reset timing in resets_at/resets_in_seconds.
  // Mirrors CPA's isCodexUsageLimitError + parseCodexRetryAfter.
  const usageLimitRetryMs = parseCodexUsageLimitRetryAfter(body)
  if (usageLimitRetryMs !== undefined) {
    return { kind: "quota_exhausted", retryAfterMs: usageLimitRetryMs }
  }

  if (status === 429) {
    if (body && /quota|insufficient|balance|exhaust/i.test(body)) {
      return { kind: "quota_exhausted" }
    }
    return { kind: "rate_limited", retryAfterMs }
  }

  if (status === 401) {
    return { kind: "auth_error" }
  }

  if (status === 403) {
    // CDN/WAF 返回的 403 Blocked 页面(body 是 HTML)与 API 返回的鉴权 403(body 是 JSON)
    // 是两种不同的情况。WAF 403 通常是临时的,不应锁死 credential。
    if (body && (/<!DOCTYPE/i.test(body) || /<html/i.test(body))) {
      return { kind: "server_error", retryAfterMs }
    }
    return { kind: "auth_error" }
  }

  if (status === 402) {
    return { kind: "quota_exhausted" }
  }

  if (status >= 500) {
    return { kind: "server_error", retryAfterMs }
  }

  if (status >= 400) {
    // Codex may return 400 with usage_limit_reached in the body (stream
    // terminal errors). CPA promotes these to 429; we do the same.
    if (body && isCodexUsageLimitError(body)) {
      const retryMs = parseCodexUsageLimitRetryAfter(body)
      return { kind: "quota_exhausted", retryAfterMs: retryMs }
    }
    return { kind: "client_error" }
  }

  return { kind: "unknown" }
}

/**
 * Detects Codex usage_limit_reached errors in a response body.
 * Mirrors CPA's isCodexUsageLimitError — checks error.type and top-level type.
 */
export function isCodexUsageLimitError(body: string): boolean {
  if (!body) return false
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const errorObj = parsed.error as Record<string, unknown> | undefined
    const errorType = errorObj?.type
    const errorCode = errorObj?.code
    const topLevelType = parsed.type
    return (
      errorType === "usage_limit_reached"
      || errorCode === "AccountQuotaExceeded"
      || topLevelType === "usage_limit_reached"
    )
  } catch {
    return false
  }
}

/**
 * Parses resets_at / resets_in_seconds from a Codex usage_limit_reached error
 * body and returns the retry-after duration in milliseconds.
 * Mirrors CPA's parseCodexRetryAfter.
 */
export function parseCodexUsageLimitRetryAfter(
  body?: string,
): number | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error as Record<string, unknown> | undefined
    if (!error) return undefined
    if (
      error.type !== "usage_limit_reached"
      && error.code !== "AccountQuotaExceeded"
    ) {
      return undefined
    }

    // resets_at — Unix timestamp (seconds)
    const resetsAt = error.resets_at
    if (typeof resetsAt === "number" && resetsAt > 0) {
      const resetMs = resetsAt * 1000
      const diff = resetMs - Date.now()
      if (diff > 0) {
        return Math.min(diff, DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS)
      }
    }

    // resets_in_seconds — duration in seconds
    const resetsInSeconds = error.resets_in_seconds
    if (typeof resetsInSeconds === "number" && resetsInSeconds > 0) {
      return Math.min(
        resetsInSeconds * 1000,
        DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS,
      )
    }

    // Parse "reset at" timestamp from the error message.
    // e.g. "...reset at 2026-07-16 20:27:09 +0800 CST..."
    // The offset is part of the message and must be preserved; appending "Z"
    // would treat a local time as UTC and extend the cooldown by hours.
    const message = typeof error.message === "string" ? error.message : ""
    const resetAtMatch = message.match(
      /reset at (\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}:?\d{2}))?/,
    )
    if (resetAtMatch) {
      const datePart = resetAtMatch[1].replace(" ", "T")
      const offsetRaw = resetAtMatch[2]
      let offsetPart = "Z"
      if (offsetRaw) {
        offsetPart =
          offsetRaw.includes(":") ? offsetRaw : (
            `${offsetRaw.slice(0, 3)}:${offsetRaw.slice(3)}`
          )
      }
      const resetTime = Date.parse(`${datePart}${offsetPart}`)
      if (!Number.isNaN(resetTime)) {
        const diff = resetTime - Date.now()
        if (diff > 0) {
          return Math.min(diff, DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS)
        }
      }
    }

    // No reset timing — use default quota cooldown
    return DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS
  } catch {
    return undefined
  }
}
