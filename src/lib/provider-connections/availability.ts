/**
 * Provider Connection 状态机辅助函数。
 *
 * 负责:
 * - 自动从 cooldown / quota_exhausted 状态恢复(基于时间窗口)。
 * - 根据上游错误把 credential 置入合适的失效状态。
 * - 判断 credential / connection 是否可参与调度。
 */

import consola from "consola"

import type { ApiCredential, ProviderConnection } from "./types"

import { DEFAULTS } from "./types"

/** 把过期的 cooldown / 长期 quota_exhausted 自动恢复为 ready。 */
export function refreshCredentialAvailability(
  credential: ApiCredential,
  now: number = Date.now(),
): void {
  if (
    credential.status === "cooldown"
    && credential.cooldownUntil !== undefined
    && credential.cooldownUntil <= now
  ) {
    credential.status = "ready"
    credential.cooldownUntil = undefined
  }

  if (
    credential.status === "quota_exhausted"
    && credential.cooldownUntil !== undefined
    && credential.cooldownUntil <= now
  ) {
    credential.status = "ready"
    credential.cooldownUntil = undefined
  }
}

export function refreshConnectionAvailability(
  connection: ProviderConnection,
  now: number = Date.now(),
): void {
  for (const credential of connection.credentials) {
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
  consola.warn(
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
  consola.warn(
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
  consola.warn(
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
  const retryAfterMs = parseRetryAfter(input.retryAfterHeader)

  if (status === undefined) {
    return { kind: "network_error" }
  }

  if (status === 429) {
    if (body && /quota|insufficient|balance|exhaust/i.test(body)) {
      return { kind: "quota_exhausted" }
    }
    return { kind: "rate_limited", retryAfterMs }
  }

  if (status === 401 || status === 403) {
    return { kind: "auth_error" }
  }

  if (status === 402) {
    return { kind: "quota_exhausted" }
  }

  if (status >= 500) {
    return { kind: "server_error", retryAfterMs }
  }

  if (status >= 400) {
    return { kind: "client_error" }
  }

  return { kind: "unknown" }
}

const MAX_RETRY_AFTER_MS = DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS

function parseRetryAfter(
  header: string | null | undefined,
): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.min(Math.round(asNumber * 1000), MAX_RETRY_AFTER_MS)
  }
  const asDate = Date.parse(trimmed)
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now()
    return Math.min(Math.max(delta, 0), MAX_RETRY_AFTER_MS)
  }
  return undefined
}
