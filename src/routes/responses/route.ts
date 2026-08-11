import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"

import { forwardError } from "~/lib/error"
import { respondToKnownRouteError } from "~/lib/request-lifecycle"
import { recordTraceError } from "~/lib/request-log"

import { handleResponses } from "./handler"
import { createResponsesWebSocketSession } from "./ws-handler"

export const responsesRoutes = new Hono()

const upgradeResponsesWebSocket = upgradeWebSocket((c) => {
  const session = createResponsesWebSocketSession(c)

  return {
    onMessage(event, ws) {
      session.onMessage(
        event as MessageEvent<string | ArrayBuffer>,
        ws.raw as unknown as import("./ws-handler").WebSocketSendTarget,
      )
    },
    onClose(event) {
      session.onClose(event)
    },
    onError(event) {
      session.onError(event)
    },
  }
})

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
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

responsesRoutes.get("/", (c, next) => {
  return upgradeResponsesWebSocket(c, next)
})
