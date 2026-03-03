import { Hono } from "hono"

import { logStore, type LogLevel } from "~/lib/log-store"

export const logApiRoutes = new Hono()

logApiRoutes.get("/", (c) => {
  const level = c.req.query("level") as LogLevel | undefined
  const search = c.req.query("search")
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500)
  const offset = Number(c.req.query("offset") ?? 0)

  const entries = logStore.query({ level, search, limit, offset })

  return c.json({
    entries,
    total: logStore.count(),
    limit,
    offset,
  })
})

