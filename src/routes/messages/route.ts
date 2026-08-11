import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"
import { recordTraceError } from "~/lib/request-log"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"

export const messageRoutes = new Hono()

messageRoutes.post("/", async (c) => {
  try {
    return await handleCompletion(c)
  } catch (error) {
    recordTraceError(c, error)
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

messageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c)
  } catch (error) {
    recordTraceError(c, error)
    return forwardError(c, error)
  }
})
