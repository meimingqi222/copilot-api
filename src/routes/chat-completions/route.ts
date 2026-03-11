import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleCompletion, RateLimitError, AbortError } from "./handler"

export const completionRoutes = new Hono()

completionRoutes.post("/", async (c) => {
  try {
    return await handleCompletion(c)
  } catch (error) {
    if (error instanceof RateLimitError) {
      return c.json({ error: { message: error.message, type: "error" } }, 429)
    }
    if (error instanceof AbortError) {
      return new Response(null, { status: 499 })
    }
    return forwardError(c, error)
  }
})
