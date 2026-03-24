import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"

import { handleCompletion } from "./handler"

export const completionRoutes = new Hono()

completionRoutes.post("/", async (c) => {
  try {
    return await handleCompletion(c)
  } catch (error) {
    const knownErrorResponse = respondToKnownRouteError(
      c,
      error,
      "rate_limit_error",
    )
    if (knownErrorResponse) {
      return knownErrorResponse
    }

    return forwardError(c, error)
  }
})
