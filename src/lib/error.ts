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
    for (const h of RATE_LIMIT_FORWARD_HEADERS) {
      const v = error.response.headers.get(h)
      if (v) c.header(h, v)
    }

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
