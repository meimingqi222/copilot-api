import type { Context, Next } from "hono"

import consola from "consola"

import { logStore } from "./log-store"
import { statsStore } from "./stats-store"

export const requestLogger = async (c: Context, next: Next) => {
  const start = Date.now()
  await next()
  const latencyMs = Date.now() - start

  const status = c.res.status
  let level: "info" | "warn" | "error"
  if (status >= 500) {
    level = "error"
  } else if (status >= 400) {
    level = "warn"
  } else {
    level = "info"
  }

  const accountId = c.get("accountId" as never) as string | undefined

  logStore.push({
    timestamp: Date.now(),
    level,
    message: `${c.req.method} ${c.req.path} ${status}`,
    userId: c.get("userId" as never) as string | undefined,
    username: c.get("username" as never) as string | undefined,
    accountId,
    latencyMs,
    statusCode: status,
    path: c.req.path,
  })

  // Persist stats to SQLite for request counting
  if (accountId) {
    try {
      // Always count the request
      statsStore.incrementRequests(accountId)
      // Additionally count errors separately
      if (status >= 400) {
        statsStore.incrementErrors(accountId)
      }
    } catch {
      // Stats persistence failure should not affect request flow
      consola.debug("Failed to persist stats")
    }
  }
}
