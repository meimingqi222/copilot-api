import consola from "consola"
import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"

import { type MimoMessage, mimoConnections } from "~/services/mimo/connections"

export const mimoWsRoute = new Hono()

const upgradeMimoWebSocket = upgradeWebSocket((c) => {
  const accountId = c.req.query("accountId")

  if (!accountId) {
    consola.warn("Rejecting Claw WS connection: missing accountId query param")
    return {}
  }

  return {
    onOpen(_event, ws) {
      consola.info(`[Claw WS] Node connected for account: ${accountId}`)

      // Store connection
      mimoConnections.set(accountId, {
        accountId,
        ws: ws as any,
        activeRequests: new Map(),
      })
    },
    onMessage(event, _ws) {
      try {
        const msg = JSON.parse(event.data.toString()) as MimoMessage
        const conn = mimoConnections.get(accountId)
        if (conn && msg.req_id) {
          const callback = conn.activeRequests.get(msg.req_id)
          if (callback) {
            callback(msg)
          }
        }
      } catch (e) {
        consola.error("[Claw WS] Error parsing incoming message:", e)
      }
    },
    onClose(_event, _ws) {
      consola.info(`[Claw WS] Node disconnected for account: ${accountId}`)
      const conn = mimoConnections.get(accountId)
      if (conn) {
        // Reject all active requests with error
        for (const [req_id, callback] of conn.activeRequests.entries()) {
          callback({
            type: "error",
            req_id,
            body: "Node disconnected",
          })
        }
        mimoConnections.delete(accountId)
      }
    },
    onError(_event, _ws) {
      consola.error(`[Claw WS] Node error for account: ${accountId}`)
    },
  }
})

mimoWsRoute.get("/", (c, next) => {
  return upgradeMimoWebSocket(c, next)
})
