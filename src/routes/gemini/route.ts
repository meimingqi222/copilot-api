import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"
import { recordTraceError } from "~/lib/request-log"

import { handleGenerateContent } from "./handler"

export const geminiRoutes = new Hono()

/**
 * `POST /v1beta/models/{model}:{action}` where the action is `generateContent`
 * or `streamGenerateContent`. Google encodes the method inside the path
 * (`.../models/gemini-3-pro:streamGenerateContent`), so the whole tail is
 * matched with a wildcard and parsed in the handler.
 */
geminiRoutes.post("/models/*", async (c) => {
  try {
    return await handleGenerateContent(c)
  } catch (error) {
    recordTraceError(c, error)
    const knownErrorResponse = respondToKnownRouteError(c, error)
    if (knownErrorResponse) return knownErrorResponse
    return forwardError(c, error)
  }
})
