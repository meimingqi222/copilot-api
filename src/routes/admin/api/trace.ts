import { Hono } from "hono"

import { logStore } from "~/lib/log-store"
import { readPersistedRequestLogs } from "~/lib/request-log-persist"

import { handleSseStream, writeSseEvent } from "~/lib/sse"
import {
  latestTraceForSession,
  recentTraces,
  subscribeTrace,
  TRACE_KEEP,
  type TraceRecord,
  waitForTraceSeq,
} from "~/lib/trace-bus"

export const traceApiRoutes = new Hono()

/**
 * The trace view only needs the request's routing + timing shape, not the full
 * diagnostic LogEntry (snippets, mismatch flags, dump paths…). Projecting keeps
 * the live SSE frames small and the client contract stable even if LogEntry
 * grows.
 */
function toFrame(entry: TraceRecord): Record<string, unknown> {
  return {
    requestId: entry.requestId,
    seq: entry.seq,
    stage: entry.stage,
    timestamp: entry.timestamp,
    /** Still running: show it live, don't play the finished journey yet. */
    inFlight: Boolean(entry.inFlight),
    // who asked
    initiator: entry.initiator,
    username: entry.username,
    clientIp: entry.clientIp,
    userAgent: entry.userAgent,
    // what was asked
    endpoint: entry.endpoint,
    apiKind: entry.apiKind,
    method: entry.method,
    path: entry.path,
    model: entry.model,
    modelRequested: entry.modelRequested,
    modelUpstream: entry.modelUpstream,
    modelResponse: entry.modelResponse,
    reasoningEffort: entry.reasoningEffort,
    streaming: Boolean(entry.streaming),
    isTranslated: Boolean(entry.isTranslated),
    // where it went
    provider: entry.provider,
    protocol: entry.protocol,
    connectionId: entry.connectionId,
    connectionName: entry.connectionName,
    credentialId: entry.credentialId,
    credentialLabel: entry.credentialLabel,
    upstreamBaseUrl: entry.upstreamBaseUrl,
    initialTarget: entry.initialTarget,
    finalTarget: entry.finalTarget,
    // how it went
    latencyMs: entry.latencyMs,
    ttftMs: entry.ttftMs,
    generationTps: entry.generationTps,
    statusCode: entry.statusCode,
    outcome: entry.outcome,
    ok: entry.ok,
    finishReason: entry.finishReason,
    error: entry.error,
    errorType: entry.errorType,
    // failover
    attempts: entry.attempts,
    failoverCount: entry.failoverCount,
    failoverReason: entry.failoverReason,
    // candidate paths considered, chosen first
    candidates: entry.candidates,
    // routing group metadata
    routingGroupId: entry.routingGroupId,
    routingGroupName: entry.routingGroupName,
    routingGroupMembers: entry.routingGroupMembers,
    routingGroupSelectedMember: entry.routingGroupSelectedMember,
    routingStrategy: entry.routingStrategy,
    // tokens
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    totalTokens: entry.totalTokens,
  }
}

traceApiRoutes.get("/recent", (c) => {
  const raw = Number(c.req.query("limit") ?? TRACE_KEEP)
  const limit = Number.isFinite(raw) ? raw : TRACE_KEEP
  return c.json({
    traces: recentTraces(limit).map(toFrame),
    keep: TRACE_KEEP,
  })
})

/** History survives a gateway restart; live in-flight records stay on the bus. */
traceApiRoutes.get("/history", async (c) => {
  const parseTime = (value: string | undefined): number | undefined => {
    if (!value) return undefined
    const time = Number(value)
    return Number.isFinite(time) ? time : undefined
  }
  const timeFrom = parseTime(c.req.query("timeFrom"))
  const timeTo = parseTime(c.req.query("timeTo"))
  const limit = 500
  const persisted = await readPersistedRequestLogs({ timeFrom, timeTo, limit })
  const memory = logStore.query({
    timeFrom,
    timeTo,
    limit,
  }).entries
  const records = new Map<string, TraceRecord>()
  for (const entry of [...persisted, ...memory]) {
    if (entry.requestId)
      records.set(entry.requestId, {
        ...entry,
        requestId: entry.requestId,
        inFlight: false,
      })
  }
  const traces = [...records.values()]
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .slice(-limit)
    .map(toFrame)
  return c.json({ traces, limit })
})

/**
 * One session's latest route, for an agent's UI to show where a turn went
 * while the reply is still on its way:
 * `?session=<id>`, and with `?after=<seq>&wait=<seconds>` it waits (up to a
 * minute) for the route to change past `seq`. Reads nothing but the trace bus.
 */
traceApiRoutes.get("/session", async (c) => {
  const session = (c.req.query("session") ?? "").trim().slice(0, 128)
  if (!session) {
    return c.json({ error: "name the session: ?session=<id>" }, 400)
  }
  const after = Number.parseInt(c.req.query("after") ?? "0", 10) || 0
  const waitSeconds = Number.parseFloat(c.req.query("wait") ?? "0") || 0
  const waitMs = Math.min(Math.max(waitSeconds, 0), 60) * 1000

  let found = latestTraceForSession(session)
  if (waitMs > 0 && found.seq <= after) {
    await waitForTraceSeq(after, waitMs, c.req.raw.signal)
    found = latestTraceForSession(session)
  }
  return c.json({
    session,
    seq: found.seq,
    route: found.entry ? toFrame(found.entry) : null,
  })
})

/**
 * Live feed. Sends the current window as `trace` events first (so a late joiner
 * is instantly consistent), then pushes each snapshot as the request starts,
 * routes, and finishes. The stream ends when the client disconnects.
 */
traceApiRoutes.get("/stream", (c) =>
  handleSseStream(
    c,
    async (stream, signal) => {
      for (const entry of recentTraces(TRACE_KEEP)) {
        await writeSseEvent(stream, JSON.stringify(toFrame(entry)), "trace")
      }
      await new Promise<void>((resolve) => {
        const unsubscribe = subscribeTrace(({ entry }) => {
          writeSseEvent(stream, JSON.stringify(toFrame(entry)), "trace").catch(
            () => {
              // Client went away mid-write; the abort handler resolves us.
            },
          )
        })
        const onAbort = () => {
          unsubscribe()
          resolve()
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      })
    },
    { initialComment: "trace" },
  ),
)
