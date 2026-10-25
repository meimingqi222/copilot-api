import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import type { RedactionDiagnostics } from "~/lib/redaction/diagnostics"

/**
 * Per-day record of what redaction did, so the dashboard can show 7/30 days
 * across restarts. One request per line in `REDACTION_DIR/YYYY-MM-DD.jsonl`.
 * Only counts, kinds and routing are written: never a value, a hint of one,
 * or a placeholder that could be matched against a log.
 */

const KEEP_DAYS = 30
const KEEP_BYTES = 50 * 1024 * 1024

interface HistoryRecord {
  t: number
  client: string
  upstreams: Array<{ id: string; name: string; model: string }>
  total: number
  byKind: RedactionDiagnostics["byKind"]
  byLabel: RedactionDiagnostics["byLabel"]
  warned: number
  /** Labels a `block` action refused. */
  blocked: Array<string>
  restored: number
}

interface DayAggregate {
  requests: number
  replacedRequests: number
  total: number
  warned: number
  blocked: number
  byKind: Record<string, number>
  byLabel: Record<string, number>
  clients: Map<string, { requests: number; total: number }>
  upstreams: Map<string, { name: string; requests: number; total: number }>
}

function dayOf(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

let writes: Promise<void> = Promise.resolve()
let pruned = 0
const cache = new Map<string, { size: number; aggregate: DayAggregate }>()

/** Appends one request. Failures are logged, never thrown: history must not break a request. */
export function appendRedactionHistory(
  diagnostics: RedactionDiagnostics,
  route: {
    client: string
    upstreams: Array<{ id: string; name: string; model: string }>
  },
  time = Date.now(),
): void {
  const record: HistoryRecord = {
    t: time,
    client: route.client,
    upstreams: route.upstreams.map(({ id, name, model }) => ({
      id,
      name,
      model,
    })),
    total: diagnostics.total,
    byKind: diagnostics.byKind,
    byLabel: diagnostics.byLabel,
    warned: diagnostics.warned,
    blocked: diagnostics.blocked.map((item) => item.label),
    restored: diagnostics.restored,
  }
  const line = JSON.stringify(record) + "\n"
  writes = writes
    .then(async () => {
      const dir = PATHS.REDACTION_DIR
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(path.join(dir, `${dayOf(time)}.jsonl`), line, {
        mode: 0o600,
      })
      if (Date.now() - pruned > 60 * 60_000) {
        pruned = Date.now()
        await prune(dir)
      }
    })
    .catch((error: unknown) => {
      console.warn("Failed to write redaction history:", error)
    })
}

/** Resolves once every queued append is on disk (tests, shutdown). */
export function flushRedactionHistory(): Promise<void> {
  return writes
}

async function dayFiles(dir: string): Promise<Array<string>> {
  try {
    return (await fs.readdir(dir))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
  } catch {
    return []
  }
}

async function prune(dir: string): Promise<void> {
  const oldest = dayOf(Date.now() - KEEP_DAYS * 24 * 60 * 60_000)
  const files = await dayFiles(dir)
  const sizes = await Promise.all(
    files.map((name) =>
      fs.stat(path.join(dir, name)).then(
        (stat) => stat.size,
        () => 0,
      ),
    ),
  )
  let total = sizes.reduce((sum, size) => sum + size, 0)
  for (const [i, name] of files.entries()) {
    if (name.slice(0, 10) >= oldest && total <= KEEP_BYTES) break
    await fs.rm(path.join(dir, name), { force: true })
    cache.delete(path.join(dir, name))
    total -= sizes[i]
  }
}

function emptyDay(): DayAggregate {
  return {
    requests: 0,
    replacedRequests: 0,
    total: 0,
    warned: 0,
    blocked: 0,
    byKind: {},
    byLabel: {},
    clients: new Map(),
    upstreams: new Map(),
  }
}

function addRecord(day: DayAggregate, record: HistoryRecord): void {
  day.requests++
  if (record.total > 0) day.replacedRequests++
  day.total += record.total
  day.warned += record.warned
  day.blocked += record.blocked.length ? 1 : 0
  for (const [kind, n] of Object.entries(record.byKind))
    day.byKind[kind] = (day.byKind[kind] ?? 0) + n
  for (const [label, n] of Object.entries(record.byLabel))
    day.byLabel[label] = (day.byLabel[label] ?? 0) + (n ?? 0)
  const client = day.clients.get(record.client) ?? { requests: 0, total: 0 }
  client.requests++
  client.total += record.total
  day.clients.set(record.client, client)
  const seen = new Set<string>()
  for (const upstream of record.upstreams.length ?
    record.upstreams
  : [{ id: "", name: "", model: "" }]) {
    if (seen.has(upstream.id)) continue
    seen.add(upstream.id)
    const entry = day.upstreams.get(upstream.id) ?? {
      name: upstream.name || upstream.id,
      requests: 0,
      total: 0,
    }
    entry.requests++
    entry.total += record.total
    day.upstreams.set(upstream.id, entry)
  }
}

async function readDay(file: string): Promise<DayAggregate> {
  let size: number
  try {
    size = (await fs.stat(file)).size
  } catch {
    return emptyDay()
  }
  const cached = cache.get(file)
  if (cached?.size === size) return cached.aggregate
  const aggregate = emptyDay()
  const text = await fs.readFile(file, "utf8")
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      addRecord(aggregate, JSON.parse(line) as HistoryRecord)
    } catch {
      // A line half-written by a crash is skipped, not fatal.
    }
  }
  cache.set(file, { size, aggregate })
  return aggregate
}

/** Totals over the last `days` days (today included), oldest day first. */
export async function summarizeRedactionHistory(days: number) {
  await writes
  const span = Math.min(Math.max(Math.trunc(days) || 1, 1), KEEP_DAYS)
  const dir = PATHS.REDACTION_DIR
  const all = emptyDay()
  const perDay: Array<{
    day: string
    requests: number
    replacedRequests: number
    total: number
    warned: number
    blocked: number
  }> = []
  const now = new Date()
  for (let i = span - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const day = dayOf(date.getTime())
    const aggregate = await readDay(path.join(dir, `${day}.jsonl`))
    perDay.push({
      day,
      requests: aggregate.requests,
      replacedRequests: aggregate.replacedRequests,
      total: aggregate.total,
      warned: aggregate.warned,
      blocked: aggregate.blocked,
    })
    all.requests += aggregate.requests
    all.replacedRequests += aggregate.replacedRequests
    all.total += aggregate.total
    all.warned += aggregate.warned
    all.blocked += aggregate.blocked
    for (const [kind, n] of Object.entries(aggregate.byKind))
      all.byKind[kind] = (all.byKind[kind] ?? 0) + n
    for (const [label, n] of Object.entries(aggregate.byLabel))
      all.byLabel[label] = (all.byLabel[label] ?? 0) + n
    for (const [name, entry] of aggregate.clients) {
      const sum = all.clients.get(name) ?? { requests: 0, total: 0 }
      sum.requests += entry.requests
      sum.total += entry.total
      all.clients.set(name, sum)
    }
    for (const [id, entry] of aggregate.upstreams) {
      const sum = all.upstreams.get(id) ?? {
        name: entry.name,
        requests: 0,
        total: 0,
      }
      sum.requests += entry.requests
      sum.total += entry.total
      all.upstreams.set(id, sum)
    }
  }
  const byRequests = <T extends { requests: number }>(a: T, b: T) =>
    b.requests - a.requests
  return {
    days: perDay,
    requests: all.requests,
    replacedRequests: all.replacedRequests,
    total: all.total,
    warned: all.warned,
    blocked: all.blocked,
    byKind: all.byKind,
    byLabel: all.byLabel,
    clients: [...all.clients]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort(byRequests),
    upstreams: [...all.upstreams]
      .map(([id, entry]) => ({ id, ...entry }))
      .sort(byRequests),
  }
}
