import type { Context } from "hono"

import { Hono } from "hono"

import { handleSseStream, writeSseEvent } from "~/lib/sse"
import {
  recentSystemLogs,
  subscribeSystemLogs,
  type SystemLogEntry,
} from "~/lib/system-log-bus"
import {
  matchesSystemLog,
  parseSystemLogLevel,
  querySystemLogs,
  type SystemLogQuery,
} from "~/lib/system-log-query"

export const systemLogApiRoutes = new Hono()

function numberParam(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (Number.isFinite(parsed)) return parsed
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

/** The filters every endpoint here shares, from the query string. */
function queryFrom(
  c: Context,
  maxLimit: number,
  fallback: number,
): SystemLogQuery {
  const subs = c.req
    .query("sub")
    ?.split(",")
    .map((sub) => sub.trim())
    .filter(Boolean)
  const limit = numberParam(c.req.query("limit")) ?? fallback
  return {
    level: parseSystemLogLevel(c.req.query("level")),
    subs: subs?.length ? subs : undefined,
    q: c.req.query("q")?.trim() || undefined,
    req: c.req.query("req") || undefined,
    conn: c.req.query("conn") || undefined,
    connName: c.req.query("connName") || undefined,
    job: c.req.query("job") || undefined,
    run: c.req.query("run") || undefined,
    from: numberParam(c.req.query("from")),
    to: numberParam(c.req.query("to")),
    before: numberParam(c.req.query("before")),
    limit: Math.min(Math.max(1, Math.trunc(limit)), maxLimit),
  }
}

/** Newest first; `more` says older entries remain (page with `before`). */
systemLogApiRoutes.get("/", (c) => {
  c.header("Cache-Control", "no-store")
  return c.json(querySystemLogs(queryFrom(c, 1000, 200)))
})

systemLogApiRoutes.get("/export", (c) => {
  const { entries } = querySystemLogs(queryFrom(c, 20_000, 5000))
  const body = entries
    .reverse()
    .map((entry) => JSON.stringify(entry))
    .join("\n")
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
  return c.body(body ? `${body}\n` : "", 200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": `attachment; filename="system-logs-${stamp}.jsonl"`,
    "Cache-Control": "no-store",
  })
})

/** Matches the live filters; `before`, `from` and paging do not apply. */
function live(query: SystemLogQuery): (entry: SystemLogEntry) => boolean {
  const { level, subs, q, req, conn, connName, job, run } = query
  const probe = { level, subs, q, req, conn, connName, job, run }
  return (entry) => matchesSystemLog(entry, probe)
}

/**
 * Live tail. Sends the recent window first (oldest to newest) as `log`
 * events, then each new entry as it is written, until the client leaves.
 */
systemLogApiRoutes.get("/stream", (c) => {
  const accept = live(queryFrom(c, 1000, 1000))
  return handleSseStream(
    c,
    async (stream, signal) => {
      for (const entry of recentSystemLogs())
        if (accept(entry))
          await writeSseEvent(stream, JSON.stringify(entry), "log")
      await new Promise<void>((resolve) => {
        const unsubscribe = subscribeSystemLogs((entry) => {
          if (!accept(entry)) return
          writeSseEvent(stream, JSON.stringify(entry), "log").catch(() => {
            // Client went away mid-write; the abort handler resolves us.
          })
        })
        const onAbort = () => {
          unsubscribe()
          resolve()
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      })
    },
    { initialComment: "system-logs" },
  )
})
