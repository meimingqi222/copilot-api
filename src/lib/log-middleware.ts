import type { Context, Next } from "hono"

import { logStore } from "./log-store"

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

  logStore.push({
    timestamp: Date.now(),
    level,
    message: `${c.req.method} ${c.req.path} ${status}`,
    userId: c.get("userId" as never) as string | undefined,
    username: c.get("username" as never) as string | undefined,
    latencyMs,
    statusCode: status,
    path: c.req.path,
  })
}
