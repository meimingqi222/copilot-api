import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { getSystemConfig, getSystemSettings } from "~/lib/system-config"

/** Matches `server-2026-06-27.log` and `server-2026-06-27.1.log`. */
const LOG_FILE_PATTERN = /^server-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/
/** Matches daily request logs and their numbered size-based segments. */
export const REQUEST_LOG_JSONL_PATTERN =
  /^requests-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

interface LogRotationConfig {
  logDir: string
  maxFileBytes: number
  retentionDays: number
  maxTotalBytes?: number
  dumpDir?: string
  requestRetentionDays?: number
}

export function readLogRotationConfig(): LogRotationConfig {
  const maxFileBytes = Number.parseInt(process.env.LOG_MAX_FILE_BYTES ?? "", 10)
  const settings = getSystemSettings()

  return {
    logDir: process.env.LOG_DIR ?? PATHS.LOG_DIR,
    dumpDir: process.env.DUMP_REQUESTS_DIR?.trim() || undefined,
    maxTotalBytes: settings.logMaxTotalBytes,
    requestRetentionDays:
      getSystemConfig().source === "webui" ?
        settings.logRetentionDays
      : positiveBytes(
          process.env.LOG_REQUEST_RETENTION_DAYS,
          settings.logRetentionDays,
        ),
    maxFileBytes:
      Number.isFinite(maxFileBytes) && maxFileBytes > 0 ?
        maxFileBytes
      : DEFAULT_MAX_FILE_BYTES,
    retentionDays: settings.logRetentionDays,
  }
}

function positiveBytes(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Only managed regular files are eligible; unrelated files and symlinks are untouched. */
export function enforceLogStorageLimits(
  config = readLogRotationConfig(),
  now = new Date(),
): void {
  const files: Array<{
    file: string
    date: string
    segment: number
    size: number
  }> = []
  const dirs = new Set([
    path.resolve(config.logDir),
    path.resolve(config.dumpDir || config.logDir),
  ])
  for (const dir of dirs) {
    let entries: Array<string>
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const match =
        /^(server|requests|request-dumps)-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.(log|jsonl)$/.exec(
          name,
        )
      if (
        !match
        || (match[1] === "server" ? match[4] !== "log" : match[4] !== "jsonl")
      )
        continue
      const file = path.join(dir, name)
      try {
        const info = fs.lstatSync(file)
        if (!info.isFile()) continue
        const days =
          match[1] === "requests" ?
            (config.requestRetentionDays
            ?? positiveBytes(
              process.env.LOG_REQUEST_RETENTION_DAYS,
              config.retentionDays,
            ))
          : config.retentionDays
        if (isLogDateExpired(match[2], now, days)) {
          try {
            fs.unlinkSync(file)
            continue
          } catch {
            /* Retry on the next sweep. */
          }
        }
        files.push({
          file,
          date: match[2],
          segment: Number(match[3] || 0),
          size: info.size,
        })
      } catch {
        /* Another writer may have removed the file. */
      }
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0)
  const limit = config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  files.sort(
    (a, b) =>
      a.date.localeCompare(b.date)
      || a.segment - b.segment
      || a.file.localeCompare(b.file),
  )
  for (const entry of files) {
    if (total <= limit) break
    try {
      fs.unlinkSync(entry.file)
      total -= entry.size
    } catch {
      /* Try other eligible files. */
    }
  }
}

const storageSweeps = new Map<string, { bytes: number; time: number }>()

/** Sweep after a segment's worth of writes or one hour, whichever comes first. */
export function maybeEnforceLogStorageLimits(
  config: LogRotationConfig,
  writtenBytes: number,
  now = new Date(),
): boolean {
  const key = JSON.stringify([
    config.logDir,
    config.dumpDir,
    config.maxTotalBytes,
    config.retentionDays,
    config.requestRetentionDays,
    process.env.LOG_REQUEST_RETENTION_DAYS,
  ])
  const previous = storageSweeps.get(key)
  const bytes = (previous?.bytes ?? 0) + writtenBytes
  if (
    previous
    && bytes
      < Math.min(
        config.maxFileBytes,
        config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      )
    && now.getTime() - previous.time < CLEANUP_INTERVAL_MS
  ) {
    previous.bytes = bytes
    return false
  }
  enforceLogStorageLimits(config, now)
  storageSweeps.set(key, { bytes: 0, time: now.getTime() })
  return true
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

function ensureLogDir(logDir: string): void {
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
    config.requestRetentionDays
    ?? (Number.isFinite(days) && days > 0 ? days : config.retentionDays)
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
  private readonly runtimeConfig: boolean

  constructor(options?: {
    config?: LogRotationConfig
    fixedPath?: string
    now?: Date
  }) {
    this.config = options?.config ?? readLogRotationConfig()
    this.runtimeConfig = !options?.config
    this.fixedPath = options?.fixedPath
    const now = options?.now ?? new Date()
    this.activeDateKey = dateKeyFromDate(now)
    this.activePath = this.fixedPath ?? this.buildPath(this.activeDateKey, 0)
    if (!this.fixedPath) {
      ensureLogDir(this.config.logDir)
      pruneExpiredLogFiles(this.config, now)
      enforceLogStorageLimits(this.config, now)
      this.lastCleanupAt = now.getTime()
    }
  }

  getActivePath(): string {
    return this.activePath
  }

  append(line: string, now = new Date()): void {
    if (this.runtimeConfig) this.config = readLogRotationConfig()
    if (this.fixedPath) {
      fs.appendFileSync(this.fixedPath, line)
      return
    }

    this.maybeCleanup(now)
    this.ensureActiveFile(line, now)
    fs.appendFileSync(this.activePath, line)
    maybeEnforceLogStorageLimits(this.config, Buffer.byteLength(line), now)
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
