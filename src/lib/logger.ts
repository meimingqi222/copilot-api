import consola, { type ConsolaReporter, type LogObject } from "consola"

import { currentLogContext } from "~/lib/log-context"
import { redactText, redactValue } from "~/lib/log-redact"
import { RotatingLogFileSink, readLogRotationConfig } from "~/lib/log-rotation"
import {
  nextSystemLogId,
  publishSystemLog,
  type SystemLogEntry,
  type SystemLogError,
  type SystemLogLevel,
} from "~/lib/system-log-bus"

type FileLogLevel =
  | "box"
  | "debug"
  | "error"
  | "fail"
  | "fatal"
  | "info"
  | "log"
  | "ready"
  | "start"
  | "verbose"
  | "success"
  | "trace"
  | "warn"

const REDACTED_VALUE = "[redacted]"

/** Usage metrics must stay visible in logs for cache debugging. */
const USAGE_METRIC_KEYS = new Set([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cached_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
])

/** Windsurf cache-debug keys — must not match /token/i or /session/i redaction. */
const CACHE_DEBUG_SAFE_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "field7",
  "field28",
  "field33",
  "raw",
  "rawUsage",
  "sessionId",
  "cascadeId",
  "promptId",
  "conversationKey",
  "cacheHitPct",
  "parsedUsage",
])

function shouldRedactLogKey(key: string): boolean {
  if (USAGE_METRIC_KEYS.has(key)) return false
  if (CACHE_DEBUG_SAFE_KEYS.has(key)) return false

  const lower = key.toLowerCase()
  if (
    /authorization|api[-_]?key|password|secret|cookie|image|base64/.test(lower)
  ) {
    return true
  }
  if (/\bdata\b/i.test(key) && !lower.endsWith("metadata")) return true
  if (/token/i.test(key)) return true
  if (/session/i.test(key)) return true

  return false
}

const FILE_LEVEL_RANK: Record<FileLogLevel, number> = {
  fatal: 0,
  error: 0,
  fail: 0,
  warn: 1,
  success: 2,
  info: 2,
  log: 2,
  ready: 2,
  start: 2,
  box: 2,
  debug: 3,
  trace: 4,
  verbose: 4,
}

let fileReporterInstalled = false
let fileMinLevel: FileLogLevel = "info"
let fileMinLevelLocked = false
let logSink: RotatingLogFileSink | null = null

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  )
}

function sanitizeMeta(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMeta(item))
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([key, nested]) => [
      key,
      shouldRedactLogKey(key) ? REDACTED_VALUE : sanitizeMeta(nested),
    ])
    return Object.fromEntries(entries)
  }

  return value
}

/** Consola's types as the system log's levels. */
const SYSTEM_LEVEL: Record<string, SystemLogLevel> = {
  fatal: "fatal",
  error: "error",
  fail: "error",
  warn: "warn",
  log: "info",
  info: "info",
  success: "info",
  ready: "info",
  start: "info",
  box: "info",
  debug: "debug",
  trace: "debug",
  verbose: "debug",
}

const STACK_MAX = 8 * 1024
const BODY_MAX = 2 * 1024

interface HttpErrorLike {
  response?: { status?: unknown }
  responseBody?: unknown
}

/** An error as the log keeps it: its stack, and an HTTP failure's status and body start. */
function serializeLogError(error: Error): SystemLogError {
  const http = error as Error & HttpErrorLike
  const out: SystemLogError = {
    name: error.name,
    message: redactText(error.message),
  }
  if (error.stack) out.stack = redactText(error.stack.slice(0, STACK_MAX))
  if (typeof http.response?.status === "number")
    out.status = http.response.status
  if (typeof http.responseBody === "string" && http.responseBody)
    out.body = redactText(http.responseBody.slice(0, BODY_MAX))
  if (error.cause !== undefined)
    out.cause = redactText(
      error.cause instanceof Error ?
        `${error.cause.name}: ${error.cause.message}`
      : String(error.cause),
    )
  return out
}

function describePart(part: unknown): string {
  if (typeof part === "string") return part
  if (part instanceof Error) return part.message
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

function splitMessageAndMeta(args: Array<unknown>): {
  message: string
  meta?: Record<string, unknown>
  error?: Error
} {
  const parts = [...args]
  let meta: Record<string, unknown> | undefined
  if (isPlainObject(parts.at(-1)))
    meta = sanitizeMeta(parts.pop()) as Record<string, unknown>
  const error = parts.find((part): part is Error => part instanceof Error)
  // "Refresh failed:" followed by the error reads as one sentence; a bare
  // error is its own message.
  const message = parts.map((part) => describePart(part)).join(" ")
  return { message, meta, error }
}

export function shouldWriteToFile(
  type: string,
  minLevel: FileLogLevel,
): boolean {
  const fileType = type as FileLogLevel
  if (!(fileType in FILE_LEVEL_RANK)) return true
  return FILE_LEVEL_RANK[fileType] <= FILE_LEVEL_RANK[minLevel]
}

type FileLogInput = Pick<LogObject, "args" | "date" | "type"> & {
  tag?: string
}

/** The structured entry for one consola call, or null below the file level. */
function toSystemLogEntry(
  logObj: FileLogInput,
  minLevel: FileLogLevel = fileMinLevel,
): SystemLogEntry | null {
  if (!shouldWriteToFile(logObj.type, minLevel)) return null
  const { message, meta, error } = splitMessageAndMeta(logObj.args)
  const context = currentLogContext()
  const entry: SystemLogEntry = {
    id: nextSystemLogId(),
    ts: logObj.date.getTime(),
    level: SYSTEM_LEVEL[logObj.type] ?? "info",
    sub: logObj.tag || pendingSub || "app",
    msg: redactText(message),
  }
  if (meta && Object.keys(meta).length > 0)
    entry.ctx = redactValue(meta) as Record<string, unknown>
  if (error) entry.err = serializeLogError(error)
  // An explicit id in the meta wins over the ambient one.
  const req =
    typeof meta?.requestId === "string" ? meta.requestId : context?.req
  const conn =
    typeof meta?.connectionId === "string" ? meta.connectionId : context?.conn
  if (req) entry.req = req
  if (conn) entry.conn = conn
  if (context?.job) entry.job = context.job
  if (context?.run) entry.run = context.run
  return entry
}

/** One JSONL line of `system-YYYY-MM-DD.jsonl`, or null below the file level. */
export function formatLogLine(
  logObj: FileLogInput,
  minLevel: FileLogLevel = fileMinLevel,
): string | null {
  const entry = toSystemLogEntry(logObj, minLevel)
  return entry ? `${JSON.stringify(entry)}\n` : null
}

function writeLogLine(line: string): void {
  try {
    logSink?.append(line)
  } catch {
    // best-effort; never let logging break the main flow
  }
}

const fileReporter: ConsolaReporter = {
  log(logObj) {
    let entry: SystemLogEntry | null
    try {
      entry = toSystemLogEntry(logObj)
    } catch {
      return
    }
    if (!entry) return
    writeLogLine(`${JSON.stringify(entry)}\n`)
    publishSystemLog(entry)
  },
}

interface InitLoggerOptions {
  verbose?: boolean
}

function ensureLogSink(): RotatingLogFileSink {
  if (!logSink) {
    logSink = new RotatingLogFileSink()
  }
  return logSink
}

/** Install the file reporter and configure console/file levels. Idempotent. */
export function initLogger(options: InitLoggerOptions = {}): void {
  if (options.verbose) {
    consola.level = 5
  }

  if (!fileMinLevelLocked) {
    fileMinLevel =
      options.verbose || process.env.LOG_FILE_DEBUG === "true" ?
        "debug"
      : "info"
  }

  const sink = ensureLogSink()
  const rotation = readLogRotationConfig()

  if (fileReporterInstalled) return
  consola.addReporter(fileReporter)
  fileReporterInstalled = true
  logger.debug("File logging enabled", {
    path: sink.getActivePath(),
    maxFileBytes: rotation.maxFileBytes,
    retentionDays: rotation.retentionDays,
  })
}

/**
 * True when a `logger.debug(...)` call would actually be recorded somewhere.
 *
 * Consola filters by level inside `logger.debug`, but the arguments are built
 * by the caller first — a per-frame `logger.debug("...", { ...meta })` in a
 * streaming loop allocates its meta object thousands of times per response and
 * then throws every one away. Guard those call sites with this; ordinary
 * once-per-request logging does not need it.
 */
export function isDebugLoggingEnabled(): boolean {
  return consola.level >= 4 || fileMinLevel === "debug"
}

export function setRuntimeLogLevel(level: "warn" | "info" | "debug"): void {
  consola.level = { warn: 1, info: 3, debug: 4 }[level]
  fileMinLevel = level
  fileMinLevelLocked = true
}

/** Test hook: redirect file output and reset reporter state. */
export function configureLoggerForTest(options: {
  logFilePath: string
  minLevel?: FileLogLevel
  resetReporter?: boolean
}): void {
  logSink = new RotatingLogFileSink({ fixedPath: options.logFilePath })
  fileMinLevel = options.minLevel ?? "info"
  fileMinLevelLocked = true
  if (options.resetReporter) {
    consola.removeReporter(fileReporter)
    fileReporterInstalled = false
    initLogger()
  }
}

/** Test hook: restore production defaults. */
export function resetLoggerForTest(): void {
  consola.removeReporter(fileReporter)
  logSink = null
  fileMinLevel = "info"
  fileMinLevelLocked = false
  fileReporterInstalled = false
}

/** Test hook: invoke the file reporter directly. */
export function writeTestLogLine(logObj: FileLogInput): void {
  const line = formatLogLine(logObj)
  if (line) writeLogLine(line)
}

// Report each call synchronously: Consola's repeated-message batching flushes
// under a later caller's async context and loses the original request/job tag.
consola.options.throttle = 0

export const logger = consola

/** Subsystem of the `createLogger` call being reported, if any. */
let pendingSub: string | undefined

const LOG_METHODS = new Set<PropertyKey>([
  ...Object.keys(FILE_LEVEL_RANK),
  "warn",
  "success",
  "trace",
])

/**
 * A logger whose lines carry a subsystem (`sub` in the system log): "quota",
 * "auth", "cli", "dispatch"…
 *
 * It calls the root logger's own methods, not a `withTag` child: consola
 * copies the level and reporters into a child when it is made (modules make
 * theirs before `initLogger` adds the file reporter), and tests that spy on
 * `logger.info` must still see these calls with their arguments. The
 * subsystem reaches the file reporter through `pendingSub`, set for the
 * synchronous length of the call.
 */
export function createLogger(sub: string): typeof consola {
  return new Proxy(consola, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown
      if (typeof value !== "function" || !LOG_METHODS.has(property))
        return value
      return (...args: Array<unknown>) => {
        const previous = pendingSub
        pendingSub = sub
        try {
          return (value as (...input: Array<unknown>) => unknown).apply(
            target,
            args,
          )
        } finally {
          pendingSub = previous
        }
      }
    },
  })
}
