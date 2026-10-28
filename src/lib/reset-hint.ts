/**
 * 上游错误里“什么时候恢复”的单一解析点。
 *
 * 失败体有四种常见写法：`resets_at`（秒/毫秒 epoch）、
 * `resets_in_seconds`、`retry_after`（秒或 HTTP-date）、
 * `retry_after_ms`；自然语言还可能写 “reset at …”“resets in 3h”
 * 或 Claude Code 的 “limit reached|<unix>”。这里只负责还原成绝对
 * 时刻；是否封顶、是否据此休息由调用方决定。
 */

import { isRecord } from "~/lib/json-shape"

interface UsageLimitRefusal {
  message: string
  /** 绝对毫秒；没有写明恢复时刻时省略。 */
  resetAtMs?: number
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/** 秒和毫秒 epoch 都出现过；用 1e12 作分界（当前秒级 epoch 远小于它）。 */
function epochMs(value: unknown): number | undefined {
  const numeric = finiteNumber(value)
  if (numeric !== undefined) return numeric < 1e12 ? numeric * 1000 : numeric
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/** Retry-After 语义：数字是秒，字符串还可能是 HTTP-date。 */
function relativeMs(value: unknown, now: number): number | undefined {
  const numeric = finiteNumber(value)
  if (numeric !== undefined) return numeric * 1000
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed) && parsed > now) return parsed - now
  }
  return undefined
}

/** “3h0m0s”“1 day”“45m” 这类相对时长。 */
function durationMs(input: string): number | undefined {
  const normalized = input
    .toLowerCase()
    .replaceAll(/(\d)([a-z])/g, "$1 $2")
    .replaceAll(/([a-z])(\d)/g, "$1 $2")
    .replaceAll(/(\d)-([a-z])/g, "$1 $2")

  const regex =
    /(\d+(?:\.\d+)?)\s*(milliseconds?|seconds?|minutes?|mins?|hours?|hrs?|days?|ms|[smhd])\b/gi
  let totalMs = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(normalized)) !== null) {
    const value = Number.parseFloat(match[1])
    const unit = match[2].toLowerCase()
    if (Number.isNaN(value) || value < 0) continue
    if (unit === "ms" || unit.startsWith("milli")) totalMs += value
    else if (unit === "s" || unit.startsWith("sec")) totalMs += value * 1000
    else if (unit === "m" || unit.startsWith("min")) {
      totalMs += value * 60 * 1000
    } else if (
      unit === "h"
      || unit.startsWith("hr")
      || unit.startsWith("hour")
    ) {
      totalMs += value * 60 * 60 * 1000
    } else if (unit === "d" || unit.startsWith("day")) {
      totalMs += value * 24 * 60 * 60 * 1000
    }
  }
  return totalMs > 0 ? totalMs : undefined
}

/** “UTC+8” / “+8” / “+0800” / “+08:00” → “+08:00”，缺省按 UTC。 */
function normalizeUtcOffset(raw: string | undefined): string {
  if (!raw) return "Z"
  const compact = raw.replaceAll(/\s/g, "")
  const parsed = compact.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/)
  if (!parsed) return "Z"
  return `${parsed[1]}${parsed[2].padStart(2, "0")}:${parsed[3] ?? "00"}`
}

function resetAtFromWords(text: string, now: number): number | undefined {
  // Claude Code: "usage limit reached|<unix seconds>"
  const limit = /limit reached\|(\d{10,13})\b/i.exec(text)
  if (limit) {
    const at = epochMs(limit[1])
    if (at !== undefined && at > now) return at
  }

  // "reset at 2026-07-16 20:27:09 +0800 CST" / "将在 ... UTC+8 重置"
  const resetAt =
    /(?:reset at|将在)\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)\s*(?:UTC\s*)?([+-]\s*\d{1,2}(?::?\d{2})?)?/i.exec(
      text,
    )
  if (resetAt) {
    const datePart = resetAt[1].replaceAll(" ", "T")
    const at = Date.parse(`${datePart}${normalizeUtcOffset(resetAt[2])}`)
    if (!Number.isNaN(at) && at > now) return at
  }

  // "resets in 3h0m0s" / "resets in 1 day"
  const resetIn =
    /resets?\s+in\s+((?:\d+(?:\.\d+)?\s*[a-z-]+\s*)+)(?:,|\.|please|$)/i.exec(
      text,
    )
  if (resetIn) {
    const ms = durationMs(resetIn[1])
    if (ms !== undefined) return now + ms
  }

  // "reached your 5-hour limit" / "5 hour limit"
  const hourLimit = /(\d+(?:\.\d+)?)(?:\s*-\s*|\s+)hour\b/i.exec(text)
  if (hourLimit) {
    const hours = Number.parseFloat(hourLimit[1])
    if (Number.isFinite(hours) && hours > 0) {
      return now + Math.floor(hours * 60 * 60 * 1000)
    }
  }

  return undefined
}

/**
 * 从一个错误对象还原绝对恢复时刻。
 *
 * 字段优先级与旧代码一致：`resets_at` → `resets_in_seconds` →
 * `retry_after` → `retry_after_ms`；都没有时再看 `message` 里的文字。
 */
function parseResetAt(
  error: Record<string, unknown> | undefined,
  now: number,
): number | undefined {
  if (!error) return undefined

  const resetsAt = epochMs(error.resets_at ?? error.resetsAt)
  if (resetsAt !== undefined && resetsAt > now) return resetsAt

  const resetsInSeconds = finiteNumber(
    error.resets_in_seconds ?? error.resetsInSeconds,
  )
  if (resetsInSeconds !== undefined) return now + resetsInSeconds * 1000

  const retryAfter = error.retry_after ?? error.retryAfter
  const retryMs = relativeMs(retryAfter, now)
  if (retryMs !== undefined) return now + retryMs

  const retryAfterMs = finiteNumber(error.retry_after_ms ?? error.retryAfterMs)
  if (retryAfterMs !== undefined) return now + retryAfterMs

  const message = typeof error.message === "string" ? error.message : ""
  return message ? resetAtFromWords(message, now) : undefined
}

/**
 * 从完整响应体还原绝对恢复时刻。错误对象可能在顶层、`error` 或
 * `response.error` 下；字段都没有时再试自然语言。
 */
export function parseResetAtFromBody(
  body: string | null | undefined,
  now: number,
): number | undefined {
  if (!body) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return resetAtFromWords(body, now)
  }
  if (!isRecord(parsed)) return resetAtFromWords(body, now)

  const error = isRecord(parsed.error) ? parsed.error : undefined
  const response = isRecord(parsed.response) ? parsed.response : undefined
  const nested = isRecord(response?.error) ? response.error : undefined
  for (const candidate of [error, nested, parsed]) {
    const at = parseResetAt(candidate, now)
    if (at !== undefined) return at
  }
  return resetAtFromWords(body, now)
}

/** `usage_limit_reached` / `AccountQuotaExceeded` 的共享识别与恢复时刻。 */
export function readUsageLimitRefusal(
  body: string | null | undefined,
  now: number = Date.now(),
): UsageLimitRefusal | undefined {
  if (!body) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const error = isRecord(parsed.error) ? parsed.error : undefined
  const response = isRecord(parsed.response) ? parsed.response : undefined
  const nested = isRecord(response?.error) ? response.error : undefined
  // `error` and `response.error` can disagree: a generic outer error may wrap
  // the refusal. Try every place the wire uses, not just the first one found.
  const candidates = [error, nested, parsed].filter(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== undefined,
  )
  for (const candidate of candidates) {
    const type = candidate.type ?? parsed.type
    const code = candidate.code
    const isRefusal =
      type === "usage_limit_reached"
      || code === "usage_limit_reached"
      || code === "AccountQuotaExceeded"
    if (!isRefusal) continue

    const message =
      typeof candidate.message === "string" && candidate.message.trim() ?
        candidate.message.trim()
      : "usage limit reached"
    let resetAtMs = parseResetAt(candidate, now)
    if (resetAtMs === undefined) {
      for (const other of candidates) {
        if (other === candidate) continue
        resetAtMs = parseResetAt(other, now)
        if (resetAtMs !== undefined) break
      }
    }
    resetAtMs ??= resetAtFromWords(body, now)
    return resetAtMs === undefined ? { message } : { message, resetAtMs }
  }
  return undefined
}
