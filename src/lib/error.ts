import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response
  responseBody: string

  constructor(message: string, response: Response, responseBody = "") {
    super(message)
    this.response = response
    this.responseBody = responseBody
  }
}

export function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    // Prefer error.message over responseBody for locally-generated errors
    // responseBody is used for upstream API error responses
    const errorText = error.responseBody || error.message
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    const status = error.response.status as ContentfulStatusCode
    const retryAfter = error.response.headers.get("Retry-After")
    if (retryAfter) {
      c.header("Retry-After", retryAfter)
    }
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
