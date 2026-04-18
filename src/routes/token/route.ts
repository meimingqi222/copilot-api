import { Hono } from "hono"

import { getActiveAccount, getCopilotToken } from "~/lib/accounts"
import { forwardError } from "~/lib/error"
import { checkProtectedRouteGuard } from "~/lib/protected-route-guard"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  try {
    checkProtectedRouteGuard(c, { routeKind: "token" })
    const account = getActiveAccount()
    return c.json({
      token: getCopilotToken(account),
    })
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
