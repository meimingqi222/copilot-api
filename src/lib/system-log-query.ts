/**
 * Reads the system log back for the admin page and the diagnostic bundle.
 *
 * Files are the history (`system-YYYY-MM-DD[.N].jsonl`, newest first); the
 * plain-text `server-*.log` an earlier version wrote is parsed into the same
 * entries, so a log from before an upgrade can still be looked at.
 */

import fs from "node:fs"
import path from "node:path"

import { redactText, redactValue } from "~/lib/log-redact"
import { parseRotatedLogFileName } from "~/lib/log-rotation"
import { PATHS } from "~/lib/paths"
import type { SystemLogEntry, SystemLogLevel } from "~/lib/system-log-bus"

const LEVEL_RANK: Record<SystemLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
}

export interface SystemLogQuery {
  /** Lowest level to include. */
  level?: SystemLogLevel
  /** Subsystems, any of. */
  subs?: Array<string>
  /** Case-insensitive text in the message, error or context. */
  q?: string
  req?: string
  conn?: string
  /** Historical untagged lines may only identify the quoted connection name. */
  connName?: string
  job?: string
  run?: string
  from?: number
  to?: number
  /** Only entries strictly older than this timestamp (paging). */
  before?: number
  limit?: number
}

export function parseSystemLogLevel(
  value: string | undefined,
): SystemLogLevel | undefined {
  return value && value in LEVEL_RANK ? (value as SystemLogLevel) : undefined
}

interface LogFile {
  file: string
  dateKey: string
  segment: number
  legacy: boolean
}

function listSystemLogFiles(dir = PATHS.LOG_DIR): Array<LogFile> {
  let names: Array<string>
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const files: Array<LogFile> = []
  for (const name of names) {
    const parsed = parseRotatedLogFileName(name)
    if (parsed) files.push({ file: path.join(dir, name), ...parsed })
  }
  // Newest first: later day, then later segment; the same day's JSONL file
  // ahead of its legacy text file (the upgrade happened that day).
  return files.sort(
    (a, b) =>
      b.dateKey.localeCompare(a.dateKey)
      || Number(a.legacy) - Number(b.legacy)
      || b.segment - a.segment,
  )
}

const LEGACY_LEVEL: Record<string, SystemLogLevel> = {
  ERROR: "error",
  FAIL: "error",
  FATAL: "fatal",
  WARN: "warn",
  DEBUG: "debug",
  TRACE: "debug",
  VERBOSE: "debug",
}

/** `2026-06-27T14:57:37.244Z [WARN] [tag] message {"meta":1}` as an entry. */
function parseLegacyLogLine(
  line: string,
  id: number,
): SystemLogEntry | undefined {
  const match = /^(\S+) \[([A-Z]+)\](?: \[([^\]]+)\])? (.*)$/.exec(line)
  if (!match) return undefined
  const ts = Date.parse(match[1])
  if (!Number.isFinite(ts)) return undefined
  let msg = match[4]
  let ctx: Record<string, unknown> | undefined
  const brace = msg.indexOf(" {")
  if (brace >= 0 && msg.endsWith("}")) {
    try {
      ctx = JSON.parse(msg.slice(brace + 1)) as Record<string, unknown>
      msg = msg.slice(0, brace)
    } catch {
      // Not trailing meta; keep the whole message.
    }
  }
  // Written before value-level redaction existed: redact on the way out.
  const entry: SystemLogEntry = {
    id,
    ts,
    level: LEGACY_LEVEL[match[2]] ?? "info",
    sub: match[3] ?? "app",
    msg: redactText(msg),
  }
  if (ctx) entry.ctx = redactValue(ctx) as Record<string, unknown>
  const req = ctx?.requestId
  if (typeof req === "string") entry.req = req
  return entry
}

function parseLine(
  line: string,
  legacy: boolean,
  id: number,
): SystemLogEntry | undefined {
  if (!line.trim()) return undefined
  if (legacy) return parseLegacyLogLine(line, id)
  try {
    return JSON.parse(line) as SystemLogEntry
  } catch {
    return undefined // a line cut short by a crash
  }
}

export function matchesSystemLog(
  entry: SystemLogEntry,
  query: SystemLogQuery,
): boolean {
  if (query.level && LEVEL_RANK[entry.level] < LEVEL_RANK[query.level])
    return false
  if (query.subs?.length && !query.subs.includes(entry.sub)) return false
  if (query.req && entry.req !== query.req) return false
  if (query.conn) {
    const connectionId =
      entry.conn ?? entry.ctx?.connectionId ?? entry.ctx?.accountId
    if (connectionId !== undefined) {
      if (connectionId !== query.conn) return false
    } else if (!query.connName || !entry.msg.includes(`"${query.connName}"`)) {
      return false
    }
  }
  if (query.job && entry.job !== query.job) return false
  if (query.run && entry.run !== query.run) return false
  if (query.from !== undefined && entry.ts < query.from) return false
  if (query.to !== undefined && entry.ts > query.to) return false
  if (query.before !== undefined && entry.ts >= query.before) return false
  if (query.q) {
    const needle = query.q.toLowerCase()
    const haystack = [
      entry.msg,
      entry.err?.message,
      entry.err?.stack,
      entry.ctx ? JSON.stringify(entry.ctx) : "",
    ]
      .join("\n")
      .toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

/** True when nothing in a file dated `dateKey` can be at or after `from`. */
function endsBefore(dateKey: string, from: number | undefined): boolean {
  if (from === undefined) return false
  return Date.parse(`${dateKey}T23:59:59.999Z`) < from
}

/**
 * Entries matching `query`, newest first, and whether older ones remain.
 * `limit` defaults to 200 and is capped by the caller.
 */
export function querySystemLogs(
  query: SystemLogQuery,
  dir = PATHS.LOG_DIR,
): { entries: Array<SystemLogEntry>; more: boolean } {
  const limit = Math.max(1, query.limit ?? 200)
  const entries: Array<SystemLogEntry> = []
  let legacyId = 0
  for (const file of listSystemLogFiles(dir)) {
    if (endsBefore(file.dateKey, query.from)) break
    let text: string
    try {
      text = fs.readFileSync(file.file, "utf8")
    } catch {
      continue
    }
    const lines = text.split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseLine(lines[i], file.legacy, --legacyId)
      if (!entry || !matchesSystemLog(entry, query)) continue
      if (entries.length === limit) return { entries, more: true }
      entries.push(entry)
    }
  }
  return { entries, more: false }
}
