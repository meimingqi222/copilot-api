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

/**
 * A stored trace: the (possibly partial) record plus whether it is running.
 * `stale` marks one that never settled and was closed out by the TTL sweep —
 * it is no longer running, but it also never reported a result.
 */
export type TraceRecord = TraceInput & {
  inFlight?: boolean
  stale?: boolean
  seq?: number
  /**
   * 最后一次发布的时刻（总线内部用）。兜底超时看它而不是请求开始时间：
   * 重放/回填的记录可能带着很旧的 timestamp，但它们是**现在**才进入总线、
   * 并且每次 update 都会刷新——没有后续更新才是真的"没人在管"。
   */
  atMs?: number
}

/**
 * 未收尾的 in-flight 记录超过这个时长就按"未收尾"结算掉。
 *
 * 正常收尾由 middleware / 流式 producer 负责；这里是兜底：客户端硬断、进程重启、
 * 或者某条路径忘了结算时，绝不能让它在追踪视图里永远显示"进行中"（实测有 700s+
 * 的幽灵记录）。取 30 分钟——比任何正常请求都长（首帧超时 3 分钟，WS 单轮几十秒），
 * 所以不会误伤真正在跑的请求。
 */
export const TRACE_INFLIGHT_TTL_MS = 30 * 60 * 1000

const bus = new EventEmitter()
// One listener per open SSE client; unbounded on purpose.
bus.setMaxListeners(0)

const recent: Array<TraceRecord> = []
/** Monotonic sequence, bumped on every upsert, for "wait past seq" polls. */
let seqCounter = 0

/**
 * 把超时未收尾的 in-flight 记录结算掉（按"未收尾"），并通知订阅者，让已经打开的
 * 实时视图把这些幽灵条目落地，而不是一直跳秒。
 */
function sweepStaleInFlight(now: number): void {
  for (let index = 0; index < recent.length; index += 1) {
    const record = recent[index]
    if (!record?.inFlight) continue
    const lastSeenAt = record.atMs ?? 0
    if (lastSeenAt > 0 && now - lastSeenAt <= TRACE_INFLIGHT_TTL_MS) continue
    seqCounter += 1
    const settled: TraceRecord = {
      ...record,
      inFlight: false,
      stale: true,
      seq: seqCounter,
      outcome: record.outcome ?? "incomplete",
    }
    recent[index] = settled
    bus.emit("trace", { entry: settled, phase: "final" })
  }
}

function upsert(entry: TraceRecord, phase: TracePhase): void {
  const now = Date.now()
  sweepStaleInFlight(now)
  seqCounter += 1
  const stamped: TraceRecord = { ...entry, seq: seqCounter, atMs: now }
  const existing =
    entry.requestId ?
      recent.findIndex((r) => r.requestId === entry.requestId)
    : -1
  if (existing >= 0) {
    // Start/update carry partial data — merge so the later phase never drops
    // fields an earlier one already knew. `final` 总是结算态：即便这条记录先前被
    // TTL 兜底标成 stale（真跑了 30 分钟以上的长请求），拿到真结果后要把 stale 抹掉。
    recent[existing] = {
      ...recent[existing],
      ...stamped,
      ...(phase === "final" ? { stale: undefined } : {}),
    }
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
  sweepStaleInFlight(Date.now())
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

/** Test seam: run the in-flight TTL sweep as if the clock read `now`. */
export function __sweepStaleInFlightForTest(now: number): void {
  sweepStaleInFlight(now)
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
