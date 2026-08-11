import { Hono } from "hono"

import {
  logStore,
  matchesLogEntry,
  type ApiKind,
  type LogEndpoint,
  type LogLevel,
  type TraceStage,
} from "~/lib/log-store"
import {
  findPersistedRequestLog,
  iteratePersistedRequestLogs,
} from "~/lib/request-log-persist"

export const logApiRoutes = new Hono()

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

logApiRoutes.get("/", (c) => {
  const level = c.req.query("level") as LogLevel | undefined
  const search = c.req.query("search")
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500)
  const offset = Number(c.req.query("offset") ?? 0)
  const endpoint = c.req.query("endpoint") as LogEndpoint | undefined
  const apiKind = (c.req.query("apiKind") ?? endpoint) as ApiKind | undefined
  const stage = c.req.query("stage") as TraceStage | undefined
  const ok = parseBool(c.req.query("ok"))
  const outcome = c.req.query("outcome") as
    | import("~/lib/log-store").RequestOutcome
    | undefined
  const kind = c.req.query("kind")
  const provider = c.req.query("provider")
  const model = c.req.query("model")
  const connectionId = c.req.query("connectionId")
  const requestId = c.req.query("requestId")
  const statusMin = parseNumber(c.req.query("statusMin"))
  const statusMax = parseNumber(c.req.query("statusMax"))
  const status = parseNumber(c.req.query("status"))
  const hasError = parseBool(c.req.query("hasError"))
  const streaming = parseBool(c.req.query("streaming"))
  const timeFrom = parseTime(c.req.query("timeFrom"))
  const timeTo = parseTime(c.req.query("timeTo"))

  const { entries, filteredTotal } = logStore.query({
    level: level || undefined,
    search: search || undefined,
    limit,
    offset,
    endpoint: c.req.query("apiKind") ? endpoint || undefined : undefined,
    apiKind: apiKind || undefined,
    stage: stage || undefined,
    ok,
    outcome,
    kind: kind || undefined,
    provider: provider || undefined,
    model: model || undefined,
    connectionId: connectionId || undefined,
    requestId: requestId || undefined,
    statusMin: status ?? statusMin,
    statusMax: status ?? statusMax,
    hasError,
    streaming,
    timeFrom,
    timeTo,
  })

  return c.json({
    entries,
    total: filteredTotal,
    limit,
    offset,
  })
})

logApiRoutes.get("/export", (c) => {
  const search = c.req.query("search")
  const level = c.req.query("level") as LogLevel | undefined
  const endpoint = c.req.query("endpoint") as LogEndpoint | undefined
  const apiKind = (c.req.query("apiKind") ?? endpoint) as ApiKind | undefined
  const stage = c.req.query("stage") as TraceStage | undefined
  const ok = parseBool(c.req.query("ok"))
  const outcome = c.req.query("outcome") as
    | import("~/lib/log-store").RequestOutcome
    | undefined
  const kind = c.req.query("kind")
  const provider = c.req.query("provider")
  const model = c.req.query("model")
  const connectionId = c.req.query("connectionId")
  const requestId = c.req.query("requestId")
  const hasError = parseBool(c.req.query("hasError"))
  const streaming = parseBool(c.req.query("streaming"))
  const timeFrom = parseTime(c.req.query("timeFrom"))
  const timeTo = parseTime(c.req.query("timeTo"))
  const statusMin = parseNumber(c.req.query("statusMin"))
  const statusMax = parseNumber(c.req.query("statusMax"))
  const status = parseNumber(c.req.query("status"))
  const rawLimit = Number(c.req.query("limit") ?? 5000)
  const limit =
    Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 5000) : 5000

  const options: import("~/lib/log-store").LogQueryOptions = {
    level: level || undefined,
    search: search || undefined,
    limit,
    offset: 0,
    endpoint: c.req.query("apiKind") ? endpoint || undefined : undefined,
    apiKind: apiKind || undefined,
    stage: stage || undefined,
    ok,
    outcome,
    kind: kind || undefined,
    provider: provider || undefined,
    model: model || undefined,
    connectionId: connectionId || undefined,
    requestId: requestId || undefined,
    statusMin: status ?? statusMin,
    statusMax: status ?? statusMax,
    hasError,
    streaming,
    timeFrom,
    timeTo,
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

logApiRoutes.get("/:requestId", async (c) => {
  const requestId = c.req.param("requestId")
  const entry =
    logStore.getById(requestId) ?? (await findPersistedRequestLog(requestId))
  if (!entry) return c.json({ error: "Log entry not found" }, 404)
  return c.json(entry)
})

async function* filteredPersistedLogs(
  options: import("~/lib/log-store").LogQueryOptions,
  limit: number,
): AsyncGenerator<import("~/lib/log-store").LogEntry> {
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
