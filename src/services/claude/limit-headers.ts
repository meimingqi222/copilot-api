/**
 * Claude 订阅额度的 `anthropic-ratelimit-unified-*` 响应头。
 *
 * Anthropic 直连时把 5 小时 / 7 天额度放在这些头里；登录 claude.ai 的 Claude
 * Code 会把它们显示在状态栏，claude-hud 一类工具也读它们。经网关后这些头没了，
 * 所以由我们按账号已知的额度补上：每个窗口一个 0–1 的占比和 Unix 秒的重置
 * 时间，与 Anthropic 的写法一致。
 *
 * 注意：Claude Code 只有在登录 claude.ai 时才读这些头；以 API key 接入网关的
 * Claude Code 会忽略它们（magpie 01e66e0f 实测）。
 */

import type { Context } from "hono"

import {
  getMutableProviderConnection,
  getProviderConnection,
} from "~/lib/provider-connections"
import { enrichQuotaDetails } from "~/lib/quota/cycles"
import type { UsageIdentity } from "~/lib/usage"

/** 响应头里的窗口名 → 额度详情里的键。 */
const WINDOWS = [
  ["5h", "five_hour"],
  ["7d", "seven_day"],
] as const

interface StoredWindow {
  utilization?: unknown
  resets_at?: unknown
}

/** 按账号已知的额度给出这些头；没有可用的窗口就是空对象。 */
export function claudeLimitHeaders(
  details: Record<string, unknown> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!details) return headers
  for (const [name, key] of WINDOWS) {
    const window = details[key] as StoredWindow | null | undefined
    if (!window || typeof window.utilization !== "number") continue
    const reset =
      typeof window.resets_at === "string" ? Date.parse(window.resets_at) : NaN
    if (!Number.isFinite(reset)) continue
    const share = Math.min(1, Math.max(0, window.utilization))
    headers[`anthropic-ratelimit-unified-${name}-utilization`] = String(share)
    headers[`anthropic-ratelimit-unified-${name}-reset`] = String(
      Math.floor(reset / 1000),
    )
  }
  return headers
}

/** 把服务这次请求的凭据已知的额度写进响应头。 */
export function applyClaudeLimitHeaders(
  c: Context,
  identity: UsageIdentity | undefined,
): void {
  if (!identity) return
  const connection = getProviderConnection(identity.connectionId)
  const credential =
    connection?.credentials.find((item) => item.id === identity.credentialId)
    ?? connection?.credentials[0]
  for (const [name, value] of Object.entries(
    claudeLimitHeaders(credential?.quota?.details),
  ))
    c.header(name, value)
}

/** Claude Code `rate_limit_event` 的 `rate_limit_info`（宽松类型）。 */
export interface ClaudeRateLimitInfo {
  unifiedWindows?: Record<
    string,
    { utilization?: unknown; resetsAt?: unknown } | undefined
  >
}

/**
 * Claude Code 每轮都会报一次额度（`rate_limit_event`），比定时刷新的快照新。
 * 把它记进凭据的额度详情，下一个请求的响应头和管理面板都用上新数字。
 * 只改内存，持久化交给下一次额度刷新。
 */
export function recordClaudeRateLimit(
  connectionId: string,
  credentialId: string,
  info: ClaudeRateLimitInfo | undefined,
): void {
  const windows = info?.unifiedWindows
  if (!windows) return
  const connection = getMutableProviderConnection(connectionId)
  const credential =
    connection?.credentials.find((item) => item.id === credentialId)
    ?? connection?.credentials[0]
  if (!credential) return
  const details: Record<string, unknown> = {
    ...credential.quota?.details,
  }
  let changed = false
  for (const [, key] of WINDOWS) {
    const window = windows[key]
    if (
      typeof window?.utilization !== "number"
      || typeof window.resetsAt !== "number"
    )
      continue
    details[key] = {
      ...(details[key] as object | undefined),
      utilization: window.utilization,
      resets_at: new Date(window.resetsAt * 1000).toISOString(),
    }
    changed = true
  }
  if (!changed) return
  const { _quotaWindows: _stale, ...plain } = details
  credential.quota = {
    ...credential.quota,
    unlimited: credential.quota?.unlimited ?? false,
    fetchedAt: credential.quota?.fetchedAt ?? Date.now(),
    provider: credential.quota?.provider ?? "claude",
    details: enrichQuotaDetails("claude", plain),
  }
}
