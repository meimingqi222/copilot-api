import { createReadStream } from "node:fs"
import { appendFile, mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"

import type { LogEntry, RequestLogRecord } from "~/lib/log-store"

import {
  dateKeyFromDate,
  readLogRotationConfig,
  REQUEST_LOG_JSONL_PATTERN,
} from "~/lib/log-rotation"
import { logger } from "~/lib/logger"
import { sanitizeDiagnosticSnippet } from "~/lib/security-sanitizer"

let appendQueue = Promise.resolve()

function isPersistEnabled(): boolean {
  const value = process.env["LOG_PERSIST"]
  return value !== "0" && value !== "false"
}

export async function appendRequestLog(entry: RequestLogRecord): Promise<void> {
  if (!isPersistEnabled()) return
  const operation = appendQueue.then(() => appendRequestLogSerialized(entry))
  appendQueue = operation.catch(() => undefined)
  await operation
}

async function appendRequestLogSerialized(
  entry: RequestLogRecord,
): Promise<void> {
  try {
    const config = readLogRotationConfig()
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

export function buildRequestLogFileName(
  dateKey: string,
  segment: number,
): string {
  return segment === 0 ?
      `requests-${dateKey}.jsonl`
    : `requests-${dateKey}.${segment}.jsonl`
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
  sanitized.error = sanitizeDiagnosticSnippet(sanitized.error, 500)
  sanitized.errorSnippet = sanitizeDiagnosticSnippet(sanitized.errorSnippet)
  if (sanitized.diagnosticError) {
    sanitized.diagnosticError = {
      ...sanitized.diagnosticError,
      message:
        sanitizeDiagnosticSnippet(sanitized.diagnosticError.message, 500)
        ?? "Request failed",
    }
  }
  sanitized.attempts = sanitized.attempts?.map((attempt) => ({
    ...attempt,
    errorSnippet: sanitizeDiagnosticSnippet(attempt.errorSnippet),
  }))
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
  timeFrom?: number
  timeTo?: number
  limit?: number
}): Promise<Array<LogEntry>> {
  const entries: Array<LogEntry> = []
  for await (const entry of iteratePersistedRequestLogs({
    newestFirst: true,
  })) {
    if (options?.timeFrom && entry.timestamp < options.timeFrom) continue
    if (options?.timeTo && entry.timestamp > options.timeTo) continue
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
  if (!isPersistEnabled()) return
  queueMicrotask(() => void appendRequestLog(entry))
}
