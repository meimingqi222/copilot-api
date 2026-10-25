/**
 * The latest system log entries in memory, and their live subscribers.
 *
 * Files hold the history (`system-YYYY-MM-DD.jsonl`); this ring only serves
 * the admin page's first paint and the live tail, as `trace-bus` does for
 * requests.
 */

export type SystemLogLevel = "debug" | "info" | "warn" | "error" | "fatal"

export interface SystemLogError {
  name: string
  message: string
  stack?: string
  /** HTTP status of an `HTTPError`. */
  status?: number
  /** Redacted start of an upstream response body. */
  body?: string
  cause?: string
}

export interface SystemLogEntry {
  /** Monotonic within this process; files written before a restart reuse ids. */
  id: number
  ts: number
  level: SystemLogLevel
  /** Subsystem: the logger tag, or "app" for untagged calls. */
  sub: string
  msg: string
  ctx?: Record<string, unknown>
  err?: SystemLogError
  req?: string
  conn?: string
  job?: string
  run?: string
}

const KEEP = 1000
const ring: Array<SystemLogEntry> = []
const subscribers = new Set<(entry: SystemLogEntry) => void>()
let sequence = 0

export function nextSystemLogId(): number {
  return ++sequence
}

export function publishSystemLog(entry: SystemLogEntry): void {
  ring.push(entry)
  if (ring.length > KEEP) ring.splice(0, ring.length - KEEP)
  for (const subscriber of subscribers) {
    try {
      subscriber(entry)
    } catch {
      // A broken subscriber must not break logging.
    }
  }
}

export function recentSystemLogs(): Array<SystemLogEntry> {
  return [...ring]
}

export function subscribeSystemLogs(
  subscriber: (entry: SystemLogEntry) => void,
): () => void {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}

export function clearSystemLogBusForTest(): void {
  ring.length = 0
  subscribers.clear()
  sequence = 0
}
