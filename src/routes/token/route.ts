import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { getFirstAvailableAccountManagedConnection } from "~/lib/legacy-accounts"
import { checkProtectedRouteGuard } from "~/lib/protected-route-guard"
import { getConnectionCopilotToken } from "~/lib/provider-connections"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"
import { recordTraceError } from "~/lib/request-log"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  try {
    checkProtectedRouteGuard(c, { routeKind: "token" })
    // Phase 1.7:直接用 connection 原生,不再经由 getActiveAccount() →
    // Account 快照 → getCopilotToken(account) 桥接。
    const connection = getFirstAvailableAccountManagedConnection()
    if (!connection) {
      return c.json(
        {
          error:
            "No available accounts (all disabled or no accounts configured)",
        },
        503,
      )
    }
    return c.json({
      token: getConnectionCopilotToken(connection),
    })
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

    recordTraceError(c, error)
    return forwardError(c, error)
  }
})
