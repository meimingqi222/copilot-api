import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import { logger } from "~/lib/logger"

export class HTTPError extends Error {
  response: Response
  responseBody: string

  constructor(message: string, response: Response, responseBody = "") {
    super(message)
    this.response = response
    this.responseBody = responseBody
  }
}

/**
 * Marker for a *local* pre-send rejection: a proxy-side gate (per-credential
 * in-flight cap, per-account concurrency) refused the turn because it is
 * locally saturated, not because the upstream failed.
 *
 * Callers classify these by `instanceof` (never by status) so they can skip
 * cooldown and label the trace as a dispatch/proxy condition rather than an
 * upstream failure. Living in `lib/error` lets low-level logger code recognize
 * them without importing the service modules that throw them (which would
 * cycle). `RateLimitQueueFullError` is not a member yet: it is a plain `Error`
 * today, so joining would require converting it to an `HTTPError` first.
 */
export abstract class LocalConcurrencyLimitError extends HTTPError {}

/**
 * Marker for a *local* unavailability: the request cannot be served because of
 * a machine-level condition (e.g. a required CLI binary is not installed), not
 * because the credential or the upstream failed.
 *
 * Unlike `LocalConcurrencyLimitError` — where trying another route target can
 * succeed — retrying a different account is pointless: every account hits the
 * same missing binary. The failover loop must neither cool the credential nor
 * advance to the next target; it rethrows immediately.
 */
export abstract class LocalUnavailableError extends HTTPError {}

export class UpstreamTransportError extends HTTPError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    const responseBody = JSON.stringify({
      error: {
        code: "upstream_transport_error",
        message,
        retryable: true,
        type: "upstream_error",
      },
    })
    super(
      message,
      new Response(responseBody, {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
      responseBody,
    )
    this.name = "UpstreamTransportError"
    this.cause = options.cause
  }
}

export function forwardError(c: Context, error: unknown) {
  logger.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const status = error.response.status as ContentfulStatusCode

    // 透传所有限流相关 headers(Retry-After 标准 + retry-after-ms Anthropic +
    // x-ratelimit-reset OpenAI),客户端 SDK 据此计算退避时间。
    copyRateLimitHeaders(c, error.response.headers)

    // 如果 responseBody 已是合法 JSON,直接透传原样。这样调用方
    // (如 prepareRequestAdmission) 可以按 endpoint 构造 Anthropic 风格
    // `{ type: "error", error: { type, message } }` 或 OpenAI 风格
    // `{ error: { message, type, code } }`,不会被这里二次包装。
    const body = error.responseBody
    if (body) {
      try {
        JSON.parse(body)
        return c.body(body, status)
      } catch {
        // not JSON, fall through to default wrapping
      }
      logger.error("HTTP error:", body)
    } else {
      logger.error("HTTP error:", error.message)
    }

    // 默认包装(适用于只提供 message 的场景)。
    const errorText = body || error.message
    return c.json(
      {
        error: {
          message: errorText,
          type: status === 429 ? "rate_limit_error" : "error",
        },
      },
      status,
    )
  }

  return c.json(
    {
      error: {
        message: "Internal server error",
        type: "error",
      },
    },
    500,
  )
}

/**
 * 限流相关 headers,forwardError 透传到客户端。
 * - Retry-After: HTTP 标准,秒数或 HTTP-date
 * - retry-after-ms: Anthropic 风格,毫秒数(更高精度)
 * - x-ratelimit-reset: OpenAI 风格,秒数
 */
const RATE_LIMIT_FORWARD_HEADERS = [
  "Retry-After",
  "retry-after-ms",
  "x-ratelimit-reset",
] as const

/**
 * 把上游错误响应里的限流 headers 抄到下游响应上。流式首包失败改走正常
 * HTTP 状态后,各协议自己的错误体翻译也要带上这组头(否则只修了状态码,
 * 读头的客户端依然拿不到退避时间)。
 */
export function copyRateLimitHeaders(c: Context, source: Headers): void {
  for (const h of RATE_LIMIT_FORWARD_HEADERS) {
    const v = source.get(h)
    if (v) c.header(h, v)
  }
}

/**
 * 按秒数直接设置下游限流 headers(用于错误本身不带上游响应头的场景,
 * 如本地 guard 拒绝或已知路由错误自带的 retryAfterSeconds)。
 */
export function setRateLimitHeaders(c: Context, retryAfterMs: number): void {
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  c.header("Retry-After", String(seconds))
  c.header("retry-after-ms", String(Math.round(retryAfterMs)))
  c.header("x-ratelimit-reset", String(seconds))
}
