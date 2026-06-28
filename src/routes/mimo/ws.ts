import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"

import { logger } from "~/lib/logger"
import { state } from "~/lib/state"
import {
  isValidMimoWsTokenForAccount,
  type MimoMessage,
  mimoConnections,
} from "~/services/mimo/connections"
import { markAccountFailed, markAccountReady } from "~/services/mimo/manager"

export const mimoWsRoute = new Hono()

const upgradeMimoWebSocket = upgradeWebSocket((c) => {
  const accountId = c.req.query("accountId")

  if (!accountId) {
    logger.debug("Rejecting Claw WS connection: missing accountId query param")
    return {}
  }

  return {
    onOpen(_event, ws) {
      logger.info(`[Claw WS] Node connected for account: ${accountId}`)

      mimoConnections.set(accountId, {
        accountId,
        ws,
        activeRequests: new Map(),
      })
      markAccountReady(accountId)
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
        if (conn && msg.id) {
          const callback = conn.activeRequests.get(msg.id)
          if (callback) {
            callback(msg)
          }
        }
      } catch (e) {
        logger.error("[Claw WS] Error parsing incoming message:", e)
      }
    },
    onClose(_event, _ws) {
      logger.info(`[Claw WS] Node disconnected for account: ${accountId}`)
      const conn = mimoConnections.get(accountId)
      if (conn) {
        for (const [reqId, callback] of conn.activeRequests.entries()) {
          callback({
            type: "error",
            id: reqId,
            error: "Node disconnected",
          })
        }
        mimoConnections.delete(accountId)
      }
      markAccountFailed(accountId, "Bridge node disconnected")
    },
    onError(_event, _ws) {
      logger.error(`[Claw WS] Node error for account: ${accountId}`)
    },
  }
})

mimoWsRoute.get("/", async (c, next) => {
  const accountId = c.req.query("accountId")
  if (!accountId) {
    return c.text("Missing accountId", 400)
  }

  // Accept token auth via header or query param
  const token = c.req.header("x-mimo-ws-token") ?? c.req.query("token")
  if (!isValidMimoWsTokenForAccount(accountId, token)) {
    logger.warn(
      `Rejecting Claw WS connection: invalid token for account ${accountId}`,
    )
    return c.text("Unauthorized", 401)
  }

  const account = state.accounts.find((item) => item.id === accountId)
  if (!account || !account.enabled || account.provider !== "mimo-aistudio") {
    logger.debug(`Rejecting Claw WS connection: invalid account ${accountId}`)
    return c.text("Forbidden", 403)
  }

  return upgradeMimoWebSocket(c, next)
})
