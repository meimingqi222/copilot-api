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
    const errorText = error.responseBody
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
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
