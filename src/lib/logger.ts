import consola, { type ConsolaReporter, type LogObject } from "consola"

import {
  RotatingLogFileSink,
  type LogRotationConfig,
  readLogRotationConfig,
} from "~/lib/log-rotation"
import { PATHS } from "~/lib/paths"

export type FileLogLevel =
  | "debug"
  | "error"
  | "fail"
  | "info"
  | "log"
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
  error: 0,
  fail: 0,
  warn: 1,
  success: 2,
  info: 2,
  log: 2,
  debug: 3,
  trace: 4,
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

function splitMessageAndMeta(args: Array<unknown>): {
  message: string
  meta?: Record<string, unknown>
} {
  if (args.length === 0) {
    return { message: "" }
  }

  let meta: Record<string, unknown> | undefined
  const messageParts = [...args]

  const last = messageParts.at(-1)
  if (isPlainObject(last)) {
    meta = sanitizeMeta(last) as Record<string, unknown>
    messageParts.pop()
  }

  const message = messageParts
    .map((part) => {
      if (typeof part === "string") return part
      if (part instanceof Error) return part.message
      try {
        return JSON.stringify(part)
      } catch {
        return String(part)
      }
    })
    .join(" ")

  return { message, meta }
}

export function shouldWriteToFile(
  type: string,
  minLevel: FileLogLevel,
): boolean {
  const fileType = type as FileLogLevel
  if (!(fileType in FILE_LEVEL_RANK)) return true
  return FILE_LEVEL_RANK[fileType] <= FILE_LEVEL_RANK[minLevel]
}

export type FileLogInput = Pick<LogObject, "args" | "date" | "type"> & {
  tag?: string
}

export function formatLogLine(
  logObj: FileLogInput,
  minLevel: FileLogLevel = fileMinLevel,
): string | null {
  const type = logObj.type as FileLogLevel
  if (!shouldWriteToFile(type, minLevel)) return null

  const { message, meta } = splitMessageAndMeta(logObj.args)
  const ts = logObj.date.toISOString()
  const level = type.toUpperCase()
  const tag = logObj.tag ? ` [${logObj.tag}]` : ""
  const metaStr =
    meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ""

  return `${ts} [${level}]${tag} ${message}${metaStr}\n`
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
    const line = formatLogLine(logObj)
    if (line) writeLogLine(line)
  },
}

export interface InitLoggerOptions {
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

/** Tagged child logger, e.g. createLogger("windsurf") → [windsurf] prefix. */
export function createLogger(tag: string) {
  return logger.withTag(tag)
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
    fileReporterInstalled = false
    initLogger()
  }
}

/** Test hook: restore production defaults. */
export function resetLoggerForTest(): void {
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

/** Test hook: construct a rotating sink with explicit config. */
export function createRotatingLogSinkForTest(options: {
  logDir: string
  maxFileBytes: number
  retentionDays: number
  now?: Date
}): RotatingLogFileSink {
  const config: LogRotationConfig = {
    logDir: options.logDir,
    maxFileBytes: options.maxFileBytes,
    retentionDays: options.retentionDays,
  }
  return new RotatingLogFileSink({ config, now: options.now })
}

export function getActiveLogFilePath(): string {
  return logSink?.getActivePath() ?? PATHS.LOG_FILE
}

export const logger = consola
