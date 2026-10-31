import { createReadStream } from "node:fs"
import { appendFile, mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"

import type { LogEntry, RequestLogRecord } from "~/lib/log-store"

import {
  dateKeyFromDate,
  maybeEnforceLogStorageLimits,
  readLogRotationConfig,
  REQUEST_LOG_JSONL_PATTERN,
} from "~/lib/log-rotation"
import { logger } from "~/lib/logger"
import { isLlmRequest } from "~/lib/llm-request"
import { createDumpSanitizer } from "~/lib/request-dump-sanitizer"

let appendQueue = Promise.resolve()

function isPersistEnabled(): boolean {
  const value = process.env["LOG_PERSIST"]
  return value !== "0" && value !== "false"
}

export async function appendRequestLog(entry: RequestLogRecord): Promise<void> {
  if (!isPersistEnabled()) return
  const config = readLogRotationConfig()
  const operation = appendQueue.then(() =>
    appendRequestLogSerialized(entry, config),
  )
  appendQueue = operation.catch(() => undefined)
  await operation
}

async function appendRequestLogSerialized(
  entry: RequestLogRecord,
  config: ReturnType<typeof readLogRotationConfig>,
): Promise<void> {
  try {
    await mkdir(config.logDir, { recursive: true })
    const line = `${JSON.stringify(sanitizePersistedEntry(entry))}\n`
    const dateKey = dateKeyFromDate(new Date(entry.timestamp))
    const file = await selectAppendFile(
      config.logDir,
      dateKey,
      Buffer.byteLength(line),
      config.maxFileBytes,
    )
    await appendFile(file, line, "utf8")
    maybeEnforceLogStorageLimits(config, Buffer.byteLength(line))
  } catch (error) {
    logger.warn("Failed to persist request log:", error)
  }
}

async function selectAppendFile(
  logDir: string,
  dateKey: string,
  lineBytes: number,
  maxFileBytes: number,
): Promise<string> {
  const segments = (await listRequestLogFiles(logDir))
    .filter((file) => file.dateKey === dateKey)
    .sort((a, b) => a.segment - b.segment)
  const segment = segments.at(-1)?.segment ?? 0
  const candidate = join(logDir, buildRequestLogFileName(dateKey, segment))
  let size = 0
  try {
    size = (await stat(candidate)).size
  } catch {
    // A missing initial segment starts at size zero.
  }
  return size > 0 && size + lineBytes > maxFileBytes ?
      join(logDir, buildRequestLogFileName(dateKey, segment + 1))
    : candidate
}

function buildRequestLogFileName(dateKey: string, segment: number): string {
  return segment === 0 ?
      `requests-${dateKey}.jsonl`
    : `requests-${dateKey}.${segment}.jsonl`
}

const ERROR_MAX_LENGTH = 500
const SNIPPET_MAX_LENGTH = 512

/**
 * Persisted logs are on by default, so they get the same secret scrubber as the
 * request dump rather than the weaker diagnostic-snippet filter: credentials in
 * upstream error echoes (`sk-…`, `ghp_…`, `passwd=…`) must not reach disk in
 * clear text. One sanitizer per entry lets a secret learned from one error field
 * also mask its echo in another.
 */
function sanitizePersistedErrors(entry: RequestLogRecord): void {
  const sources = [
    entry.error,
    entry.errorSnippet,
    entry.diagnosticError?.message,
    ...(entry.attempts ?? []).map((attempt) => attempt.errorSnippet),
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  if (sources.length === 0) return
  const scrub = createDumpSanitizer(sources)
  const clean = (value: string | undefined, maxLength: number) =>
    value ? scrub.snippet(value).slice(0, maxLength) : undefined
  entry.error = clean(entry.error, ERROR_MAX_LENGTH)
  entry.errorSnippet = clean(entry.errorSnippet, SNIPPET_MAX_LENGTH)
  if (entry.diagnosticError) {
    entry.diagnosticError = {
      ...entry.diagnosticError,
      message:
        clean(entry.diagnosticError.message, ERROR_MAX_LENGTH)
        ?? "Request failed",
    }
  }
  entry.attempts = entry.attempts?.map((attempt) => ({
    ...attempt,
    errorSnippet: clean(attempt.errorSnippet, SNIPPET_MAX_LENGTH),
  }))
}

export function sanitizePersistedEntry(
  entry: RequestLogRecord,
): RequestLogRecord {
  const sanitized = { ...entry }
  delete sanitized.sessionId
  if (sanitized.upstreamBaseUrl) {
    try {
      sanitized.upstreamBaseUrl = new URL(sanitized.upstreamBaseUrl).origin
    } catch {
      delete sanitized.upstreamBaseUrl
    }
  }
  sanitizePersistedErrors(sanitized)
  return sanitized
}

interface RequestLogFile {
  name: string
  dateKey: string
  segment: number
}

async function listRequestLogFiles(
  logDir: string,
): Promise<Array<RequestLogFile>> {
  try {
    return (await readdir(logDir)).flatMap((name) => {
      const match = REQUEST_LOG_JSONL_PATTERN.exec(name)
      return match ?
          [{ name, dateKey: match[1], segment: Number(match[2] || 0) }]
        : []
    })
  } catch {
    return []
  }
}

export async function* iteratePersistedRequestLogs(options?: {
  newestFirst?: boolean
}): AsyncGenerator<LogEntry> {
  const logDir = readLogRotationConfig().logDir
  const files = (await listRequestLogFiles(logDir)).sort((a, b) =>
    a.dateKey === b.dateKey ?
      a.segment - b.segment
    : a.dateKey.localeCompare(b.dateKey),
  )
  if (options?.newestFirst) files.reverse()
  for (const file of files) {
    const lines = createInterface({
      input: createReadStream(join(logDir, file.name), { encoding: "utf8" }),
      crlfDelay: Infinity,
    })
    if (options?.newestFirst) {
      const fileEntries: Array<LogEntry> = []
      for await (const line of lines) parseLine(line, fileEntries)
      for (const entry of fileEntries.reverse()) yield entry
    } else {
      for await (const line of lines) {
        const parsed: Array<LogEntry> = []
        parseLine(line, parsed)
        if (parsed[0]) yield parsed[0]
      }
    }
  }
}

function parseLine(line: string, output: Array<LogEntry>): void {
  if (!line) return
  try {
    output.push(JSON.parse(line) as LogEntry)
  } catch {
    // Ignore a partial final line left by an interrupted append.
  }
}

export async function readPersistedRequestLogs(options?: {
  llmOnly?: boolean
  timeFrom?: number
  timeTo?: number
  limit?: number
}): Promise<Array<LogEntry>> {
  const entries: Array<LogEntry> = []
  for await (const entry of iteratePersistedRequestLogs({
    newestFirst: true,
  })) {
    if (options?.timeFrom !== undefined && entry.timestamp < options.timeFrom)
      continue
    if (options?.timeTo !== undefined && entry.timestamp > options.timeTo)
      continue
    if (options?.llmOnly && !isLlmRequest(entry)) continue
    entries.push(entry)
    if (options?.limit && entries.length >= options.limit) break
  }
  return entries
}

export async function findPersistedRequestLog(
  requestId: string,
): Promise<LogEntry | undefined> {
  for await (const entry of iteratePersistedRequestLogs({
    newestFirst: true,
  })) {
    if (entry.requestId === requestId) return entry
  }
  return undefined
}

export function appendRequestLogSync(entry: RequestLogRecord): void {
  void appendRequestLog(entry)
}
