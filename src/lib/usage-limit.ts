/**
 * 线上(客户端可见)的"额度用尽"改写。
 *
 * ChatGPT/Codex 的套餐窗口用尽时回 429 + `error.type = "usage_limit_reached"`,
 * 重置时刻放在 `resets_at` / `resets_in_seconds`(流里是 `response.error`)。
 * 按 Responses 协议跑的客户端把那个 type 当终态:本轮直接结束,用户得在窗口
 * 恢复后自己重打一遍。同一个拒绝按普通限流告诉它 —— 429 + `rate_limit_exceeded`
 * + `Retry-After` —— 客户端就会自己等到重置时刻再发同一轮
 * (codex 的 `RetryLimit` 会 `sleep_until(Retry-After)` 后重发)。
 *
 * 只改写"说得清什么时候恢复"的拒绝:没给时间的额度用尽保持原样,免得把客户端
 * 按本地猜出来的 24 小时恢复窗口挂住。
 */

import { readUsageLimitRefusal } from "~/lib/reset-hint"

/** 改写后的错误体最长可信多久(周/月窗口留足,再长就当没说)。 */
const MAX_RESET_HORIZON_MS = 8 * 24 * 60 * 60 * 1000
/** `Retry-After` 至少一秒,免得客户端 0 秒重试打转。 */
const MIN_RETRY_AFTER_MS = 1000

/** `Retry-After`(秒或 HTTP-date)换算成的重置时刻。 */
function resetInstantFromHeader(
  raw: string | null | undefined,
  now: number,
): number | undefined {
  if (!raw) return undefined
  const value = raw.trim()
  if (!value) return undefined
  const seconds = Number.parseFloat(value)
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return undefined
    return now + Math.min(seconds * 1000, MAX_RESET_HORIZON_MS)
  }
  const at = Date.parse(value)
  if (Number.isNaN(at) || at <= now) return undefined
  return Math.min(at, now + MAX_RESET_HORIZON_MS)
}

/**
 * 额度用尽里写明的重置时刻距现在多久(ms);不是这种拒绝、或没说时间时
 * undefined。调用方自己决定要不要按本地策略截断。
 */
export function usageLimitResetMs(
  body: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const refusal = readUsageLimitRefusal(body, now)
  if (!refusal?.resetAtMs) return undefined
  return Math.min(refusal.resetAtMs, now + MAX_RESET_HORIZON_MS) - now
}

interface RetryableUsageLimit {
  /** 对客户端应回的状态:额度用尽是 429,不是请求错误。 */
  status: 429
  /** 厂商自己的说法,原样带给客户端。 */
  message: string
  /** 客户端协议形状的错误体。 */
  body: string
  /** 距厂商写明的重置时刻的毫秒数。 */
  retryAfterMs: number
}

/**
 * 把额度用尽的拒绝改写成客户端可自行等待并重试的限流错误。
 *
 * 返回 undefined 表示"别动它":不是额度用尽、或者它没说什么时候恢复
 * (后者保持终态,免得客户端按本地猜出的恢复窗口长睡)。
 */
export function retryableUsageLimit(input: {
  status: number
  body?: string | null
  retryAfterHeader?: string | null
  /** 客户端说 Anthropic 的 Messages 协议。 */
  anthropic?: boolean
  now?: number
}): RetryableUsageLimit | undefined {
  const now = input.now ?? Date.now()
  // 400 是 codex 流式终态错误的写法(usage_limit_reached 塞在 400 里);
  // 语义上它仍是限流,按 429 交出去客户端才会重试。
  if (input.status !== 429 && input.status !== 400) return undefined
  const refusal = readUsageLimitRefusal(input.body, now)
  if (!refusal) return undefined
  const bodyReset =
    refusal.resetAtMs === undefined ?
      undefined
    : Math.min(refusal.resetAtMs, now + MAX_RESET_HORIZON_MS)
  const resetAtMs =
    bodyReset ?? resetInstantFromHeader(input.retryAfterHeader, now)
  if (resetAtMs === undefined) return undefined
  const retryAfterMs = Math.max(MIN_RETRY_AFTER_MS, resetAtMs - now)
  return {
    status: 429,
    message: refusal.message,
    body:
      input.anthropic ?
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: refusal.message },
        })
      : JSON.stringify({
          error: {
            message: refusal.message,
            type: "rate_limit_exceeded",
            param: null,
            code: "rate_limit_exceeded",
          },
        }),
    retryAfterMs,
  }
}
