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

/** How many recent requests the live view keeps. */
export const TRACE_KEEP = 60

export type TracePhase = "start" | "update" | "final"

/** What a publisher hands in: a full settled record, or a partial snapshot. */
export type TraceInput = Partial<RequestLogRecord> & { requestId: string }

/** A stored trace: the (possibly partial) record plus whether it is running. */
export type TraceRecord = TraceInput & { inFlight?: boolean; seq?: number }

const bus = new EventEmitter()
// One listener per open SSE client; unbounded on purpose.
bus.setMaxListeners(0)

const recent: Array<TraceRecord> = []
/** Monotonic sequence, bumped on every upsert, for "wait past seq" polls. */
let seqCounter = 0

function upsert(entry: TraceRecord, phase: TracePhase): void {
  seqCounter += 1
  const stamped: TraceRecord = { ...entry, seq: seqCounter }
  const existing =
    entry.requestId ?
      recent.findIndex((r) => r.requestId === entry.requestId)
    : -1
  if (existing >= 0) {
    // Start/update carry partial data — merge so the later phase never drops
    // fields an earlier one already knew.
    recent[existing] = { ...recent[existing], ...stamped }
  } else {
    recent.push(stamped)
  }
  if (recent.length > TRACE_KEEP) recent.splice(0, recent.length - TRACE_KEEP)
  const stored = existing >= 0 ? recent[existing]! : stamped
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
  seqCounter = 0
}

/**
 * The latest trace for a session, and its sequence: where one conversation's
 * turn went, from the trace the
 * gateway already keeps. Returns `seq` 0 and no record when the session has
 * none yet.
 */
export function latestTraceForSession(sessionId: string): {
  seq: number
  entry?: TraceRecord
} {
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i]!
    if (entry.sessionId === sessionId) {
      return { seq: entry.seq ?? 0, entry }
    }
  }
  return { seq: 0, entry: undefined }
}

/** The current sequence, for `after` comparisons across sessions. */
export function traceSeq(): number {
  return seqCounter
}

/**
 * Wait until a trace is published past `afterSeq`, or `timeoutMs` elapses.
 * `signal` aborts the wait early. Resolves with the seq reached.
 */
export function waitForTraceSeq(
  afterSeq: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number> {
  if (seqCounter > afterSeq || timeoutMs <= 0) {
    return Promise.resolve(seqCounter)
  }
  return new Promise<number>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener("abort", done)
      resolve(seqCounter)
    }
    const unsubscribe = subscribeTrace(() => done())
    const timer = setTimeout(done, timeoutMs)
    if (signal) {
      if (signal.aborted) done()
      else signal.addEventListener("abort", done, { once: true })
    }
  })
}
