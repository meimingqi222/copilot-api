import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"

import { forwardError } from "~/lib/error"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"

import { handleResponses } from "./handler"
import { createResponsesWebSocketSession } from "./ws-handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
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

responsesRoutes.get(
  "/",
  upgradeWebSocket((c) => {
    const session = createResponsesWebSocketSession(c)

    return {
      onMessage(event, ws) {
        session.onMessage(
          event as MessageEvent<string | ArrayBuffer>,
          ws.raw as unknown as import("./ws-handler").WebSocketSendTarget,
        )
      },
      onClose() {
        session.onClose()
      },
      onError() {
        session.onError()
      },
    }
  }),
)
