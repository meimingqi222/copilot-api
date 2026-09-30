// Trace bus: the live feed behind the admin "请求追踪 / Requests" view.
//
// A request is published three times on its way through the gateway:
//   start  — as soon as the request is opened (client, endpoint known)
//   update — when routing resolves / each upstream attempt opens
//   final  — when the request is logged (the full, settled entry)
//
// Records are upserted by requestId so the view shows a request *while it is
// still in flight* and then settles it in place, instead of only ever seeing
// finished requests. The ring buffer keeps a short human-scale window for the
// initial paint and replay; subscribers drive `/admin/api/trace/stream`.

import { EventEmitter } from "node:events"

import type { RequestLogRecord } from "~/lib/log-store"

/** How many recent requests the live view keeps, mirroring magpie's traceKeep. */
export const TRACE_KEEP = 60

export type TracePhase = "start" | "update" | "final"

/** What a publisher hands in: a full settled record, or a partial snapshot. */
export type TraceInput = Partial<RequestLogRecord> & { requestId: string }

/** A stored trace: the (possibly partial) record plus whether it is running. */
export type TraceRecord = TraceInput & { inFlight?: boolean }

const bus = new EventEmitter()
// One listener per open SSE client; unbounded on purpose.
bus.setMaxListeners(0)

const recent: Array<TraceRecord> = []

function upsert(entry: TraceRecord, phase: TracePhase): void {
  const existing =
    entry.requestId ?
      recent.findIndex((r) => r.requestId === entry.requestId)
    : -1
  if (existing >= 0) {
    // Start/update carry partial data — merge so the later phase never drops
    // fields an earlier one already knew.
    recent[existing] = { ...recent[existing], ...entry }
  } else {
    recent.push(entry)
  }
  if (recent.length > TRACE_KEEP) recent.splice(0, recent.length - TRACE_KEEP)
  const stored = recent.at(-1) ?? entry
  bus.emit("trace", { entry: stored, phase })
}

/**
 * Publish a request snapshot. `final` settles it; anything else marks it as
 * still in flight. Called from the request log middleware (start/final) and
 * from routing (`update`).
 */
export function publishTrace(
  entry: TraceInput,
  phase: TracePhase = "final",
): void {
  upsert({ ...entry, inFlight: phase !== "final" }, phase)
}

/** The most recent traces, oldest first (in-flight ones included). */
export function recentTraces(limit = TRACE_KEEP): Array<TraceRecord> {
  const n = Math.min(Math.max(Math.trunc(limit) || TRACE_KEEP, 1), TRACE_KEEP)
  return recent.slice(-n)
}

/** Subscribe to trace events. Returns an unsubscribe function. */
export function subscribeTrace(
  listener: (event: { entry: TraceRecord; phase: TracePhase }) => void,
): () => void {
  bus.on("trace", listener)
  return () => {
    bus.off("trace", listener)
  }
}

/** Test seam: drop buffered traces and listeners. */
export function clearTraceBusForTest(): void {
  recent.length = 0
  bus.removeAllListeners()
}
