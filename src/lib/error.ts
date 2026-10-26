import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { IRUsage } from "~/services/ir/types"

import { logger } from "~/lib/logger"
import { retryableUsageLimit } from "~/lib/usage-limit"

export class HTTPError extends Error {
  response: Response
  responseBody: string
  /** Reported consumption survives a terminal error without changing its status. */
  reportedUsage?: IRUsage
  serviceTier?: string

  constructor(message: string, response: Response, responseBody = "") {
    super(message)
    this.response = response
    this.responseBody = responseBody
  }
}

/** The upstream cannot serve this model; preserve its error and try another target. */
export class UpstreamModelUnavailableError extends HTTPError {}

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

/** This target cannot honor a requested wire contract; another target may. */
export class LocalPayloadUnsupportedError extends HTTPError {
  constructor(message: string) {
    super(message, new Response(null, { status: 422 }), message)
  }
}

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

/**
 * 本地背压(排队/并发门禁)的 429。
 *
 * 光是 429 不够:Codex 这类客户端只按 `Retry-After` 决定要不要重来,读不到
 * 就把整轮当终态结束。所以本地拒绝也要带退避头和指明可重试的错误体。
 */
export function localRateLimitError(
  message: string,
  retryAfterMs = 1000,
): HTTPError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  const body = JSON.stringify({
    error: {
      message,
      type: "rate_limit_exceeded",
      param: null,
      code: "rate_limit_exceeded",
    },
  })
  return new HTTPError(
    message,
    new Response(body, {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(seconds),
        "retry-after-ms": String(seconds * 1000),
        "x-ratelimit-reset": String(seconds),
      },
    }),
    body,
  )
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

    // 额度用尽(Codex 的 usage_limit_reached)按可重试的限流交出去:那些客户端
    // 看到该 type 就结束本轮,看到带 Retry-After 的 429 才会等到厂商写明的
    // 重置时刻再发同一轮。没说什么时候恢复的保持原样。
    const retryable = retryableUsageLimit({
      status,
      body,
      retryAfterHeader: error.response.headers.get("retry-after"),
      anthropic: c.req.path.startsWith("/v1/messages"),
    })
    if (retryable) {
      // 立刻要等多长时间以厂商写明的重置时刻为准:上游若只带了短的
      // Retry-After(或压根没带),这里统一换成同一个数。
      setRateLimitHeaders(c, retryable.retryAfterMs)
      return c.body(retryable.body, retryable.status, {
        "Content-Type": "application/json",
      })
    }

    if (body) {
      try {
        JSON.parse(body)
        // 这些是 JSON 错误体:c.body 默认不带 Content-Type,客户端与中间层
        // 会把它当 text/plain。
        return c.body(body, status, { "Content-Type": "application/json" })
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
