import { Database } from "bun:sqlite"

import { PATHS } from "~/lib/paths"

export interface DailyStats {
  date: string
  accountId: string
  requests: number
  errors: number
}

class StatsStore {
  private db: Database | null = null

  private ensureDb(): Database {
    if (!this.db) {
      this.db = new Database(PATHS.STATS_PATH)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS daily_stats (
          date TEXT NOT NULL,
          account_id TEXT NOT NULL,
          requests INTEGER DEFAULT 0,
          errors INTEGER DEFAULT 0,
          PRIMARY KEY (date, account_id)
        )
      `)
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_date ON daily_stats(date)
      `)
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_account ON daily_stats(account_id)
      `)
    }
    return this.db
  }

  init(): void {
    this.ensureDb()
  }

  private getDateString(timestamp = Date.now()): string {
    const date = new Date(timestamp)
    return date.toISOString().split("T")[0] ?? ""
  }

  incrementRequests(accountId: string, timestamp?: number): void {
    const db = this.ensureDb()
    const date = this.getDateString(timestamp)
    const stmt = db.prepare(`
      INSERT INTO daily_stats (date, account_id, requests, errors)
      VALUES (?, ?, 1, 0)
      ON CONFLICT(date, account_id) DO UPDATE SET
        requests = requests + 1
    `)
    stmt.run(date, accountId)
  }

  incrementErrors(accountId: string, timestamp?: number): void {
    const db = this.ensureDb()
    const date = this.getDateString(timestamp)
    const stmt = db.prepare(`
      INSERT INTO daily_stats (date, account_id, requests, errors)
      VALUES (?, ?, 0, 1)
      ON CONFLICT(date, account_id) DO UPDATE SET
        errors = errors + 1
    `)
    stmt.run(date, accountId)
  }

  getTodayStats(accountId: string): { requests: number; errors: number } {
    const db = this.ensureDb()
    const date = this.getDateString()
    const stmt = db.prepare(`
      SELECT requests, errors FROM daily_stats
      WHERE date = ? AND account_id = ?
    `)
    const row = stmt.get(date, accountId) as
      | { requests: number; errors: number }
      | undefined
    return row ?? { requests: 0, errors: 0 }
  }

  getTodayStatsAll(): Map<string, { requests: number; errors: number }> {
    const db = this.ensureDb()
    const date = this.getDateString()
    const stmt = db.prepare(`
      SELECT account_id, requests, errors FROM daily_stats
      WHERE date = ?
    `)
    const rows = stmt.all(date) as Array<{
      account_id: string
      requests: number
      errors: number
    }>
    const result = new Map<string, { requests: number; errors: number }>()
    for (const row of rows) {
      result.set(row.account_id, {
        requests: row.requests,
        errors: row.errors,
      })
    }
    return result
  }

  // Get total requests/errors across all accounts for today
  getTodayTotals(): { requests: number; errors: number } {
    const db = this.ensureDb()
    const date = this.getDateString()
    const stmt = db.prepare(`
      SELECT SUM(requests) as total_requests, SUM(errors) as total_errors
      FROM daily_stats
      WHERE date = ?
    `)
    const row = stmt.get(date) as
      | { total_requests: number | null; total_errors: number | null }
      | undefined
    return {
      requests: row?.total_requests ?? 0,
      errors: row?.total_errors ?? 0,
    }
  }

  // Clean up old data (keep last N days)
  cleanup(daysToKeep = 30): void {
    if (!this.db) return
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - daysToKeep)
    const cutoffDate = cutoff.toISOString().split("T")[0] ?? ""
    const stmt = this.db.prepare(`
      DELETE FROM daily_stats WHERE date < ?
    `)
    stmt.run(cutoffDate)
  }
}

export const statsStore = new StatsStore()
