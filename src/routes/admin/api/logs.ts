import { Hono } from "hono"
import type { Context } from "hono"

import {
  logStore,
  matchesLogEntry,
  type ApiKind,
  type LogEndpoint,
  type LogEntry,
  type LogLevel,
  type LogQueryOptions,
  type RequestOutcome,
  type TraceStage,
} from "~/lib/log-store"
import {
  findPersistedRequestLog,
  iteratePersistedRequestLogs,
} from "~/lib/request-log-persist"
import {
  getFailureWire,
  isRequestDumpEnabled,
  readDumpedRequestBodies,
} from "~/lib/request-dump"
import {
  listStreamIncidents,
  readStreamIncident,
} from "~/lib/stream-diagnostics-store"

export const logApiRoutes = new Hono()

// Mounted under the existing authenticated admin API. These contain prompts.
logApiRoutes.get("/stream-incidents", async (c) => {
  c.header("Cache-Control", "no-store")
  return c.json({ incidents: await listStreamIncidents() })
})

logApiRoutes.get("/:requestId/stream-incident", async (c) => {
  c.header("Cache-Control", "no-store")
  const requestId = c.req.param("requestId")
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    return c.json({ error: "Invalid request ID" }, 400)
  const incident = await readStreamIncident(requestId)
  return incident ?
      c.json(incident)
    : c.json({ error: "Stream incident unavailable or expired" }, 404)
})

function parseNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function parseTime(v: string | undefined): number | undefined {
  if (!v) return undefined
  const n = Number(v)
  if (Number.isFinite(n)) return n
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v === "true") return true
  if (v === "false") return false
  return undefined
}

/** Shared filter fields for the log list and export endpoints. */
function parseLogFilters(
  c: Context,
): Omit<LogQueryOptions, "limit" | "offset"> {
  const level = c.req.query("level") as LogLevel | undefined
  const search = c.req.query("search")
  const endpoint = c.req.query("endpoint") as LogEndpoint | undefined
  const apiKind = (c.req.query("apiKind") ?? endpoint) as ApiKind | undefined
  const stage = c.req.query("stage") as TraceStage | undefined
  const statusMin = parseNumber(c.req.query("statusMin"))
  const statusMax = parseNumber(c.req.query("statusMax"))
  const status = parseNumber(c.req.query("status"))
  return {
    level: level || undefined,
    search: search || undefined,
    endpoint: c.req.query("apiKind") ? endpoint || undefined : undefined,
    apiKind: apiKind || undefined,
    stage: stage || undefined,
    ok: parseBool(c.req.query("ok")),
    outcome: c.req.query("outcome") as RequestOutcome | undefined,
    kind: c.req.query("kind") || undefined,
    provider: c.req.query("provider") || undefined,
    model: c.req.query("model") || undefined,
    modelMismatch: parseBool(c.req.query("modelMismatch")),
    connectionId: c.req.query("connectionId") || undefined,
    requestId: c.req.query("requestId") || undefined,
    statusMin: status ?? statusMin,
    statusMax: status ?? statusMax,
    hasError: parseBool(c.req.query("hasError")),
    streaming: parseBool(c.req.query("streaming")),
    timeFrom: parseTime(c.req.query("timeFrom")),
    timeTo: parseTime(c.req.query("timeTo")),
  }
}

logApiRoutes.get("/", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500)
  const offset = Number(c.req.query("offset") ?? 0)

  const { entries, filteredTotal } = logStore.query({
    ...parseLogFilters(c),
    limit,
    offset,
  })

  return c.json({
    entries,
    total: filteredTotal,
    limit,
    offset,
  })
})

logApiRoutes.get("/export", (c) => {
  const rawLimit = Number(c.req.query("limit") ?? 5000)
  const limit =
    Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 5000) : 5000

  const options: LogQueryOptions = {
    ...parseLogFilters(c),
    limit,
    offset: 0,
  }

  const ts = new Date().toISOString().replaceAll(/[:.]/g, "-")

  c.header("Content-Type", "application/x-ndjson; charset=utf-8")
  c.header(
    "Content-Disposition",
    `attachment; filename="copilot-api-logs-${ts}.jsonl"`,
  )
  const encoder = new TextEncoder()
  const iterator = filteredPersistedLogs(options, limit)
  return c.body(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next()
        if (next.done) controller.close()
        else
          controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`))
      },
      async cancel() {
        await iterator.return(undefined)
      },
    }),
  )
})

logApiRoutes.get("/:requestId/bodies", async (c) => {
  const requestId = c.req.param("requestId")
  const entry =
    logStore.getById(requestId) ?? (await findPersistedRequestLog(requestId))
  const dumped = await readDumpedRequestBodies(requestId)
  const wire = getFailureWire(requestId)

  // Disk archive (opt-in) has the larger per-field cap; the in-memory failure
  // copy is always present for recent failures and wins only when no file has
  // the record.
  const upstream =
    dumped?.upstream
    ?? (wire ?
      {
        timestamp: wire.timestamp,
        connectionId: wire.connectionId,
        model: wire.model,
        stripMode: wire.stripMode,
        upstreamStatus: wire.upstreamStatus,
        body: wire.upstreamBody,
        bodyBytes: wire.upstreamBodyBytes,
        truncated: wire.upstreamBodyTruncated,
        errorBody: wire.upstreamErrorBody,
        errorBodyBytes: wire.upstreamErrorBodyBytes,
        errorBodyTruncated: wire.upstreamErrorBodyTruncated,
      }
    : undefined)

  const incoming = dumped?.incoming
  const available = Boolean(incoming || upstream)
  if (!entry && !available) return c.json({ error: "Log entry not found" }, 404)

  return c.json({
    requestId,
    available,
    /** What the client sent (only recorded when DUMP_REQUESTS is on). */
    request: incoming ?? null,
    /** What this proxy sent upstream, after translation/strip. */
    upstreamRequest:
      upstream ?
        {
          connectionId: upstream.connectionId,
          model: upstream.model,
          stripMode: upstream.stripMode,
          body: upstream.body,
          bytes: upstream.bodyBytes,
          truncated: upstream.truncated,
        }
      : null,
    /** The upstream's error payload (the reason a 400 is being debugged). */
    response:
      upstream ?
        {
          status: upstream.upstreamStatus,
          body: upstream.errorBody ?? "",
          bytes: upstream.errorBodyBytes,
          truncated: upstream.errorBodyTruncated,
        }
      : null,
    /** Whether older requests can still be recovered from disk. */
    dumpEnabled: isRequestDumpEnabled(),
  })
})

logApiRoutes.get("/:requestId", async (c) => {
  const requestId = c.req.param("requestId")
  const entry =
    logStore.getById(requestId) ?? (await findPersistedRequestLog(requestId))
  if (!entry) return c.json({ error: "Log entry not found" }, 404)
  return c.json(entry)
})

async function* filteredPersistedLogs(
  options: LogQueryOptions,
  limit: number,
): AsyncGenerator<LogEntry> {
  let emitted = 0
  for await (const entry of iteratePersistedRequestLogs({
    newestFirst: true,
  })) {
    if (!matchesLogEntry(entry, options)) continue
    yield entry
    emitted += 1
    if (emitted >= limit) return
  }
}
