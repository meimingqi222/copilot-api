import consola from "consola"
import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"

import { type MimoMessage, mimoConnections } from "~/services/mimo/connections"
import { markAccountFailed, markAccountReady } from "~/services/mimo/manager"

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

      mimoConnections.set(accountId, {
        accountId,
        ws,
        activeRequests: new Map(),
      })
      void markAccountReady(accountId)
    },
    async onMessage(event, _ws) {
      try {
        const rawData = event.data
        let dataStr: string
        if (typeof rawData === "string") {
          dataStr = rawData
        } else if (rawData instanceof ArrayBuffer) {
          dataStr = new TextDecoder().decode(rawData)
        } else if (rawData instanceof Blob) {
          dataStr = await rawData.text()
        } else {
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          dataStr = String(rawData)
        }
        const msg = JSON.parse(dataStr) as MimoMessage
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
        for (const [reqId, callback] of conn.activeRequests.entries()) {
          callback({
            type: "error",
            req_id: reqId,
            body: "Node disconnected",
          })
        }
        mimoConnections.delete(accountId)
      }
      void markAccountFailed(accountId, "Bridge node disconnected")
    },
    onError(_event, _ws) {
      consola.error(`[Claw WS] Node error for account: ${accountId}`)
    },
  }
})

mimoWsRoute.get("/", (c, next) => {
  return upgradeMimoWebSocket(c, next)
})
