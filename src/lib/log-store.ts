export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEntry {
  id: number
  timestamp: number
  level: LogLevel
  message: string
  userId?: string
  username?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  latencyMs?: number
  statusCode?: number
  path?: string
  error?: string
}

const MAX_SIZE = Number(process.env["LOG_BUFFER_SIZE"] ?? 1000)

class LogStore {
  private buffer: LogEntry[] = []
  private counter = 0

  push(entry: Omit<LogEntry, "id">): void {
    if (this.buffer.length >= MAX_SIZE) this.buffer.shift()
    this.buffer.push({ id: ++this.counter, ...entry })
  }

  query(opts: {
    level?: LogLevel
    search?: string
    limit?: number
    offset?: number
  }): { entries: LogEntry[]; filteredTotal: number } {
    let results = [...this.buffer].reverse() // most recent first
    if (opts.level) results = results.filter((e) => e.level === opts.level)
    if (opts.search) {
      const q = opts.search.toLowerCase()
      results = results.filter(
        (e) =>
          e.message.toLowerCase().includes(q)
          || (e.username ?? "").toLowerCase().includes(q)
          || (e.model ?? "").toLowerCase().includes(q)
          || (e.path ?? "").toLowerCase().includes(q),
      )
    }
    const filteredTotal = results.length
    const offset = opts.offset ?? 0
    const limit = Math.min(opts.limit ?? 100, 500)
    return { entries: results.slice(offset, offset + limit), filteredTotal }
  }

  count(): number {
    return this.buffer.length
  }

  todayCount(level?: LogLevel): number {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startMs = startOfDay.getTime()
    return this.buffer.filter(
      (e) => e.timestamp >= startMs && (!level || e.level === level),
    ).length
  }
}

export const logStore = new LogStore()

