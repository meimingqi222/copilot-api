import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"

/** Matches `server-2026-06-27.log` and `server-2026-06-27.1.log`. */
export const LOG_FILE_PATTERN = /^server-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/
/** Matches daily request logs and their numbered size-based segments. */
export const REQUEST_LOG_JSONL_PATTERN =
  /^requests-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_RETENTION_DAYS = 7
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

export interface LogRotationConfig {
  logDir: string
  maxFileBytes: number
  retentionDays: number
}

export function readLogRotationConfig(): LogRotationConfig {
  const maxFileBytes = Number.parseInt(process.env.LOG_MAX_FILE_BYTES ?? "", 10)
  const retentionDays = Number.parseInt(
    process.env.LOG_RETENTION_DAYS ?? "",
    10,
  )

  return {
    logDir: process.env.LOG_DIR ?? PATHS.LOG_DIR,
    maxFileBytes:
      Number.isFinite(maxFileBytes) && maxFileBytes > 0 ?
        maxFileBytes
      : DEFAULT_MAX_FILE_BYTES,
    retentionDays:
      Number.isFinite(retentionDays) && retentionDays > 0 ?
        retentionDays
      : DEFAULT_RETENTION_DAYS,
  }
}

export function dateKeyFromDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function buildRotatedLogFileName(
  dateKey: string,
  segment: number,
): string {
  return segment === 0 ?
      `server-${dateKey}.log`
    : `server-${dateKey}.${segment}.log`
}

export function parseRotatedLogFileName(
  fileName: string,
): { dateKey: string; segment: number } | null {
  const match = LOG_FILE_PATTERN.exec(fileName)
  if (!match) return null
  return {
    dateKey: match[1],
    segment: match[2] ? Number.parseInt(match[2], 10) : 0,
  }
}

export function isLogDateExpired(
  dateKey: string,
  now: Date,
  retentionDays: number,
): boolean {
  const fileDay = Date.parse(`${dateKey}T00:00:00.000Z`)
  if (!Number.isFinite(fileDay)) return false
  const cutoff = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - retentionDays,
  )
  return fileDay < cutoff
}

export function listExpiredRotatedLogFiles(
  logDir: string,
  now: Date,
  retentionDays: number,
): Array<string> {
  let entries: Array<string>
  try {
    entries = fs.readdirSync(logDir)
  } catch {
    return []
  }

  const expired: Array<string> = []
  for (const entry of entries) {
    const parsed = parseRotatedLogFileName(entry)
    if (!parsed) continue
    if (isLogDateExpired(parsed.dateKey, now, retentionDays)) {
      expired.push(path.join(logDir, entry))
    }
  }
  return expired
}

export function pruneExpiredLogFiles(
  config: LogRotationConfig,
  now = new Date(),
): number {
  const expired = listExpiredRotatedLogFiles(
    config.logDir,
    now,
    config.retentionDays,
  )
  let removed = 0
  for (const filePath of expired) {
    try {
      fs.unlinkSync(filePath)
      removed += 1
    } catch {
      // best-effort
    }
  }
  return removed
}

export function ensureLogDir(logDir: string): void {
  fs.mkdirSync(logDir, { recursive: true })
}

export function listExpiredRequestLogs(
  logDir: string,
  now: Date,
  retentionDays: number,
): Array<string> {
  let entries: Array<string>
  try {
    entries = fs.readdirSync(logDir)
  } catch {
    return []
  }
  const expired: Array<string> = []
  for (const entry of entries) {
    const m = REQUEST_LOG_JSONL_PATTERN.exec(entry)
    if (!m) continue
    if (isLogDateExpired(m[1], now, retentionDays)) {
      expired.push(path.join(logDir, entry))
    }
  }
  return expired
}

export function pruneExpiredRequestLogs(
  config: LogRotationConfig,
  now = new Date(),
): number {
  const days = Number.parseInt(process.env.LOG_REQUEST_RETENTION_DAYS ?? "", 10)
  const retention =
    Number.isFinite(days) && days > 0 ? days : config.retentionDays
  const expired = listExpiredRequestLogs(config.logDir, now, retention)
  let removed = 0
  for (const p of expired) {
    try {
      fs.unlinkSync(p)
      removed += 1
    } catch {
      // Retention cleanup is best-effort; a busy file can be retried later.
    }
  }
  return removed
}

export class RotatingLogFileSink {
  private config: LogRotationConfig
  private activeDateKey: string
  private activeSegment = 0
  private activePath: string
  private lastCleanupAt = 0
  private readonly fixedPath?: string

  constructor(options?: {
    config?: LogRotationConfig
    fixedPath?: string
    now?: Date
  }) {
    this.config = options?.config ?? readLogRotationConfig()
    this.fixedPath = options?.fixedPath
    const now = options?.now ?? new Date()
    this.activeDateKey = dateKeyFromDate(now)
    this.activePath = this.fixedPath ?? this.buildPath(this.activeDateKey, 0)
    if (!this.fixedPath) {
      ensureLogDir(this.config.logDir)
      pruneExpiredLogFiles(this.config, now)
      this.lastCleanupAt = now.getTime()
    }
  }

  getActivePath(): string {
    return this.activePath
  }

  append(line: string, now = new Date()): void {
    if (this.fixedPath) {
      fs.appendFileSync(this.fixedPath, line)
      return
    }

    this.maybeCleanup(now)
    this.ensureActiveFile(line, now)
    fs.appendFileSync(this.activePath, line)
  }

  private buildPath(dateKey: string, segment: number): string {
    return path.join(
      this.config.logDir,
      buildRotatedLogFileName(dateKey, segment),
    )
  }

  private ensureActiveFile(line: string, now: Date): void {
    const dateKey = dateKeyFromDate(now)
    if (dateKey !== this.activeDateKey) {
      this.activeDateKey = dateKey
      this.activeSegment = 0
      this.activePath = this.buildPath(dateKey, 0)
      return
    }

    let size: number
    try {
      size = fs.statSync(this.activePath).size
    } catch {
      return
    }

    const nextSize = size + Buffer.byteLength(line, "utf8")
    if (nextSize <= this.config.maxFileBytes) return

    this.activeSegment += 1
    this.activePath = this.buildPath(dateKey, this.activeSegment)
  }

  private maybeCleanup(now: Date): void {
    if (now.getTime() - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return
    pruneExpiredLogFiles(this.config, now)
    this.lastCleanupAt = now.getTime()
  }
}
