import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"

import type { ResolvedModelPricing } from "~/lib/models-dev"
import type { ProviderId } from "~/lib/provider-config"

import { getDefaultModelPrice } from "~/lib/default-prices"
import { resolveModelsDevPriceDetailed } from "~/lib/models-dev"
import { PATHS } from "~/lib/paths"

export interface DailyStats {
  date: string
  accountId: string
  requests: number
  errors: number
}

export interface UsageStats {
  date: string
  accountId: string
  userId?: string
  model: string
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens: number
  cost?: number
  timestamp: number
  ttftMs?: number
  tps?: number
  streaming?: boolean
}

type UsageModelStats = {
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
}

type UsageDayStats = {
  date: string
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
  models: Record<string, UsageModelStats>
}

export type UsageIntervalStats = {
  slotTs: number
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
  models: Record<string, UsageModelStats>
}

export type TimestampRangeUsage = {
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
  models: Record<string, UsageModelStats>
}

type UsageDayRow = {
  date: string
  requests: number
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost: number
}

type UsageModelRow = {
  model: string
  requests: number
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost: number
}

class StatsStore {
  private db: Database | null = null
  private isTestMode = false

  useTestDb(): void {
    this.isTestMode = true
    this.db = new Database(":memory:")
    this.createTables(this.db)
  }

  private createTables(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT NOT NULL,
        account_id TEXT NOT NULL,
        requests INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        PRIMARY KEY (date, account_id)
      )
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_date ON daily_stats(date)
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_account ON daily_stats(account_id)
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS usage_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        account_id TEXT NOT NULL,
        user_id TEXT,
        model TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        timestamp INTEGER NOT NULL
      )
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_stats(date)
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_stats(account_id)
    `)
    this.ensureUsageUserColumn(db)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_stats(user_id)
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_stats(model)
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_stats(timestamp)
    `)

    // Application configuration (e.g. admin password hash)
    db.run(`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)

    // Add performance columns to usage_stats (migration for existing DBs)
    this.ensureColumn(db, "usage_stats", "ttft_ms", "REAL")
    this.ensureColumn(db, "usage_stats", "tps", "REAL")
    this.ensureColumn(db, "usage_stats", "streaming", "INTEGER DEFAULT 0")

    db.run(`
      CREATE TABLE IF NOT EXISTS model_pricing (
        model TEXT PRIMARY KEY,
        prompt_price_per_1k REAL DEFAULT 0,
        completion_price_per_1k REAL DEFAULT 0,
        cache_read_price_per_1k REAL DEFAULT 0,
        cache_write_price_per_1k REAL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS stats_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `)
    this.migrateSwe16UsageLabels(db)
  }

  /** One-time: drop obvious junk swe-1-6-fast test rows (tiny input, zero output). */
  private migrateSwe16UsageLabels(db: Database): void {
    const applied = db
      .prepare("SELECT 1 AS ok FROM stats_migrations WHERE name = ?")
      .get("swe-1-6-fast-junk-cleanup") as { ok: number } | undefined
    if (applied) return

    db.run(`
      DELETE FROM usage_stats
      WHERE model = 'swe-1-6-fast'
        AND completion_tokens = 0
        AND prompt_tokens < 200
    `)
    db.run("INSERT INTO stats_migrations (name, applied_at) VALUES (?, ?)", [
      "swe-1-6-fast-junk-cleanup",
      Date.now(),
    ])
  }

  private ensureColumn(
    db: Database,
    table: string,
    column: string,
    type: string,
  ): void {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
    }>
    if (!rows.some((r) => r.name === column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }

  private ensureUsageUserColumn(db: Database): void {
    const rows = db.prepare("PRAGMA table_info(usage_stats)").all() as Array<{
      name: string
    }>
    if (rows.some((row) => row.name === "user_id")) {
      return
    }
    db.run("ALTER TABLE usage_stats ADD COLUMN user_id TEXT")
  }

  private ensureDb(): Database {
    if (this.db) return this.db
    if (this.isTestMode) {
      this.db = new Database(":memory:")
      this.createTables(this.db)
      return this.db
    }
    mkdirSync(path.dirname(PATHS.STATS_PATH), { recursive: true })
    this.db = new Database(PATHS.STATS_PATH)
    this.createTables(this.db)
    return this.db
  }

  init(): void {
    this.ensureDb()
  }

  getDateString(timestamp = Date.now()): string {
    const date = new Date(timestamp)
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, "0")
    const d = String(date.getDate()).padStart(2, "0")
    return `${y}-${m}-${d}`
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

  incrementRequestAndError(accountId: string, timestamp?: number): void {
    const db = this.ensureDb()
    const date = this.getDateString(timestamp)
    const stmt = db.prepare(`
      INSERT INTO daily_stats (date, account_id, requests, errors)
      VALUES (?, ?, 1, 1)
      ON CONFLICT(date, account_id) DO UPDATE SET
        requests = requests + 1,
        errors = errors + 1
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

  // Usage statistics methods
  recordUsage(stats: UsageStats): void {
    const db = this.ensureDb()
    const stmt = db.prepare(`
      INSERT INTO usage_stats (
        date, account_id, user_id, model, prompt_tokens, completion_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, cost, timestamp,
        ttft_ms, tps, streaming
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      stats.date,
      stats.accountId,
      stats.userId ?? null,
      stats.model,
      stats.promptTokens,
      stats.completionTokens,
      stats.cacheReadTokens ?? 0,
      stats.cacheWriteTokens ?? 0,
      stats.totalTokens,
      stats.cost ?? 0,
      stats.timestamp,
      stats.ttftMs ?? null,
      stats.tps ?? null,
      stats.streaming ? 1 : 0,
    )
  }

  getUsageStatsForUser(
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Array<UsageDayStats> {
    const db = this.ensureDb()
    const rows = this.queryUsageDayRows(db, {
      userId,
      startDate,
      endDate,
    })

    return rows.map((row) => ({
      date: row.date,
      requests: row.requests,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens: row.total_tokens,
      cost: row.cost,
      models: this.queryUsageModelsByDate(db, row.date, undefined, userId),
    }))
  }

  getUsageStats(
    accountId?: string,
    startDate?: string,
    endDate?: string,
  ): Array<UsageDayStats> {
    const db = this.ensureDb()
    const rows = this.queryUsageDayRows(db, {
      accountId,
      startDate,
      endDate,
    })

    return rows.map((row) => ({
      date: row.date,
      requests: row.requests,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens: row.total_tokens,
      cost: row.cost,
      models: this.queryUsageModelsByDate(db, row.date, accountId),
    }))
  }

  private queryUsageDayRows(
    db: Database,
    filters: {
      accountId?: string
      userId?: string
      startDate?: string
      endDate?: string
    },
  ): Array<UsageDayRow> {
    let query = `
      SELECT
        date,
        COUNT(*) as requests,
        SUM(prompt_tokens) as prompt_tokens,
        SUM(completion_tokens) as completion_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cost) as cost
      FROM usage_stats
      WHERE 1=1
    `
    const params: Array<string> = []

    if (filters.accountId) {
      query += " AND account_id = ?"
      params.push(filters.accountId)
    }
    if (filters.userId) {
      query += " AND user_id = ?"
      params.push(filters.userId)
    }
    if (filters.startDate) {
      query += " AND date >= ?"
      params.push(filters.startDate)
    }
    if (filters.endDate) {
      query += " AND date <= ?"
      params.push(filters.endDate)
    }

    query += " GROUP BY date ORDER BY date DESC"

    const stmt = db.prepare(query)
    return stmt.all(...params) as Array<UsageDayRow>
  }

  private queryUsageModelsByDate(
    db: Database,
    date: string,
    accountId?: string,
    userId?: string,
  ): Record<string, UsageModelStats> {
    let query = `
      SELECT
        model,
        COUNT(*) as requests,
        SUM(prompt_tokens) as prompt_tokens,
        SUM(completion_tokens) as completion_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cost) as cost
      FROM usage_stats
      WHERE date = ?
    `
    const params = [date]
    if (accountId) {
      query += " AND account_id = ?"
      params.push(accountId)
    }
    if (userId) {
      query += " AND user_id = ?"
      params.push(userId)
    }
    query += `
      GROUP BY model
    `
    const modelStmt = db.prepare(query)
    const modelRows = modelStmt.all(...params) as Array<UsageModelRow>
    const models: Record<string, UsageModelStats> = {}

    for (const row of modelRows) {
      models[row.model] = {
        requests: row.requests,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        totalTokens: row.total_tokens,
        cost: row.cost,
      }
    }

    return models
  }

  clearUsageStatsForTest(): void {
    this.useTestDb()
  }

  getUsageByTimestampRange(
    accountId: string,
    startMs: number,
    endMs: number,
  ): TimestampRangeUsage {
    const db = this.ensureDb()
    const effectiveEndMs = Math.max(startMs, endMs)
    const stmt = db.prepare(`
      SELECT
        model,
        COUNT(*) as requests,
        SUM(prompt_tokens) as prompt_tokens,
        SUM(completion_tokens) as completion_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cost) as cost
      FROM usage_stats
      WHERE account_id = ?
        AND timestamp >= ?
        AND timestamp <= ?
      GROUP BY model
    `)
    const rows = stmt.all(accountId, startMs, effectiveEndMs) as Array<{
      model: string
      requests: number
      prompt_tokens: number
      completion_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
      total_tokens: number
      cost: number
    }>

    const summary: TimestampRangeUsage = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cost: 0,
      models: {},
    }

    for (const row of rows) {
      summary.requests += row.requests
      summary.promptTokens += row.prompt_tokens
      summary.completionTokens += row.completion_tokens
      summary.cacheReadTokens += row.cache_read_tokens
      summary.cacheWriteTokens += row.cache_write_tokens
      summary.totalTokens += row.total_tokens
      summary.cost += row.cost
      summary.models[row.model] = {
        requests: row.requests,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        totalTokens: row.total_tokens,
        cost: row.cost,
      }
    }

    return summary
  }

  getUsageStatsByInterval(
    intervalMinutes: number,
    accountId?: string,
    date?: string,
  ): Array<UsageIntervalStats> {
    const db = this.ensureDb()
    const effectiveDate = date ?? this.getDateString()
    const intervalMs = intervalMinutes * 60 * 1000

    let query = `
      SELECT
        (timestamp / ?) * ? AS slot_ts,
        COUNT(*) as requests,
        SUM(prompt_tokens) as prompt_tokens,
        SUM(completion_tokens) as completion_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cost) as cost,
        model
      FROM usage_stats
      WHERE date = ?
    `
    const params: Array<string | number> = [
      intervalMs,
      intervalMs,
      effectiveDate,
    ]

    if (accountId) {
      query += " AND account_id = ?"
      params.push(accountId)
    }

    query += " GROUP BY slot_ts, model ORDER BY slot_ts ASC"

    const stmt = db.prepare(query)
    const rows = stmt.all(...params) as Array<{
      slot_ts: number
      requests: number
      prompt_tokens: number
      completion_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
      total_tokens: number
      cost: number
      model: string
    }>

    const slotMap: Record<number, UsageIntervalStats> = {}
    for (const row of rows) {
      if (!(row.slot_ts in slotMap)) {
        slotMap[row.slot_ts] = {
          slotTs: row.slot_ts,
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          cost: 0,
          models: {},
        }
      }
      const slot = slotMap[row.slot_ts]
      slot.requests += row.requests
      slot.promptTokens += row.prompt_tokens
      slot.completionTokens += row.completion_tokens
      slot.cacheReadTokens += row.cache_read_tokens
      slot.cacheWriteTokens += row.cache_write_tokens
      slot.totalTokens += row.total_tokens
      slot.cost += row.cost
      const modelKey = row.model || "unknown"
      const existingModel =
        modelKey in slot.models ?
          slot.models[modelKey]
        : {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            cost: 0,
          }
      slot.models[modelKey] = {
        requests: existingModel.requests + row.requests,
        promptTokens: existingModel.promptTokens + row.prompt_tokens,
        completionTokens:
          existingModel.completionTokens + row.completion_tokens,
        cacheReadTokens: existingModel.cacheReadTokens + row.cache_read_tokens,
        cacheWriteTokens:
          existingModel.cacheWriteTokens + row.cache_write_tokens,
        totalTokens: existingModel.totalTokens + row.total_tokens,
        cost: existingModel.cost + row.cost,
      }
    }

    return Object.values(slotMap).sort((a, b) => a.slotTs - b.slotTs)
  }

  getPerformanceByModel(
    startDate?: string,
    endDate?: string,
  ): Array<{
    model: string
    requests: number
    streamingRequests: number
    avgTtftMs: number | null
    avgStreamingTps: number | null
    avgNonStreamingTps: number | null
  }> {
    const db = this.ensureDb()
    let query = `
      SELECT
        model,
        COUNT(*) as requests,
        SUM(CASE WHEN streaming = 1 THEN 1 ELSE 0 END) as streaming_requests,
        AVG(ttft_ms) as avg_ttft_ms,
        SUM(CASE WHEN streaming = 1 AND tps > 0 THEN completion_tokens ELSE 0 END) * 1.0
          / NULLIF(SUM(CASE WHEN streaming = 1 AND tps > 0 THEN completion_tokens / tps ELSE 0 END), 0) as avg_streaming_tps,
        SUM(CASE WHEN streaming = 0 AND tps > 0 THEN completion_tokens ELSE 0 END) * 1.0
          / NULLIF(SUM(CASE WHEN streaming = 0 AND tps > 0 THEN completion_tokens / tps ELSE 0 END), 0) as avg_nonstreaming_tps
      FROM usage_stats
      WHERE (ttft_ms IS NOT NULL OR tps IS NOT NULL)
    `
    const params: Array<string> = []

    if (startDate) {
      query += " AND date >= ?"
      params.push(startDate)
    }
    if (endDate) {
      query += " AND date <= ?"
      params.push(endDate)
    }

    query += " GROUP BY model ORDER BY requests DESC"

    const stmt = db.prepare(query)
    const rows = stmt.all(...params) as Array<{
      model: string
      requests: number
      streaming_requests: number
      avg_ttft_ms: number | null
      avg_streaming_tps: number | null
      avg_nonstreaming_tps: number | null
    }>

    return rows.map((row) => ({
      model: row.model,
      requests: row.requests,
      streamingRequests: row.streaming_requests,
      avgTtftMs: row.avg_ttft_ms,
      avgStreamingTps: row.avg_streaming_tps,
      avgNonStreamingTps: row.avg_nonstreaming_tps,
    }))
  }

  // Model pricing methods
  setModelPricing(
    model: string,
    pricing: {
      promptPricePer1k: number
      completionPricePer1k: number
      cacheReadPricePer1k?: number
      cacheWritePricePer1k?: number
    },
  ): void {
    const db = this.ensureDb()
    const stmt = db.prepare(`
      INSERT INTO model_pricing (
        model, prompt_price_per_1k, completion_price_per_1k,
        cache_read_price_per_1k, cache_write_price_per_1k, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        prompt_price_per_1k = excluded.prompt_price_per_1k,
        completion_price_per_1k = excluded.completion_price_per_1k,
        cache_read_price_per_1k = excluded.cache_read_price_per_1k,
        cache_write_price_per_1k = excluded.cache_write_price_per_1k,
        updated_at = excluded.updated_at
    `)
    stmt.run(
      model,
      pricing.promptPricePer1k,
      pricing.completionPricePer1k,
      pricing.cacheReadPricePer1k ?? 0,
      pricing.cacheWritePricePer1k ?? 0,
      Date.now(),
    )
  }

  hasManualModelPricing(model: string): boolean {
    const db = this.ensureDb()
    const stmt = db.prepare(`
      SELECT 1 FROM model_pricing WHERE model = ? LIMIT 1
    `)
    return stmt.get(model) !== undefined
  }

  getManualModelPricing(model: string): {
    promptPricePer1k: number
    completionPricePer1k: number
    cacheReadPricePer1k: number
    cacheWritePricePer1k: number
  } | null {
    const db = this.ensureDb()
    const stmt = db.prepare(`
      SELECT * FROM model_pricing WHERE model = ?
    `)
    const row = stmt.get(model) as
      | {
          prompt_price_per_1k: number
          completion_price_per_1k: number
          cache_read_price_per_1k: number
          cache_write_price_per_1k: number
        }
      | undefined

    if (!row) {
      return null
    }

    return {
      promptPricePer1k: row.prompt_price_per_1k,
      completionPricePer1k: row.completion_price_per_1k,
      cacheReadPricePer1k: row.cache_read_price_per_1k,
      cacheWritePricePer1k: row.cache_write_price_per_1k,
    }
  }

  resolveModelPricing(
    model: string,
    provider?: ProviderId,
  ): ResolvedModelPricing | null {
    const manual = this.getManualModelPricing(model)
    if (manual) {
      return {
        ...manual,
        source: "manual",
      }
    }
    const fromModelsDev = resolveModelsDevPriceDetailed(model, provider)
    if (fromModelsDev) {
      return fromModelsDev
    }

    const builtin = getDefaultModelPrice(model)
    if (builtin) {
      return {
        ...builtin,
        source: "builtin",
      }
    }

    return null
  }

  getModelPricing(model: string): {
    promptPricePer1k: number
    completionPricePer1k: number
    cacheReadPricePer1k: number
    cacheWritePricePer1k: number
  } | null {
    const resolved = this.resolveModelPricing(model)
    if (!resolved) {
      return null
    }
    return {
      promptPricePer1k: resolved.promptPricePer1k,
      completionPricePer1k: resolved.completionPricePer1k,
      cacheReadPricePer1k: resolved.cacheReadPricePer1k,
      cacheWritePricePer1k: resolved.cacheWritePricePer1k,
    }
  }

  getAllModelPricing(): Array<{
    model: string
    promptPricePer1k: number
    completionPricePer1k: number
    cacheReadPricePer1k: number
    cacheWritePricePer1k: number
    updatedAt: number
  }> {
    const db = this.ensureDb()
    const stmt = db.prepare(`
      SELECT * FROM model_pricing ORDER BY model
    `)
    const rows = stmt.all() as Array<{
      model: string
      prompt_price_per_1k: number
      completion_price_per_1k: number
      cache_read_price_per_1k: number
      cache_write_price_per_1k: number
      updated_at: number
    }>

    return rows.map((row) => ({
      model: row.model,
      promptPricePer1k: row.prompt_price_per_1k,
      completionPricePer1k: row.completion_price_per_1k,
      cacheReadPricePer1k: row.cache_read_price_per_1k,
      cacheWritePricePer1k: row.cache_write_price_per_1k,
      updatedAt: row.updated_at,
    }))
  }

  getConfig(key: string): string | undefined {
    const db = this.ensureDb()
    const stmt = db.prepare("SELECT value FROM app_config WHERE key = ?")
    const row = stmt.get(key) as { value: string } | undefined
    return row?.value
  }

  setConfig(key: string, value: string): void {
    const db = this.ensureDb()
    const stmt = db.prepare(`
      INSERT INTO app_config (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `)
    stmt.run(key, value, Date.now())
  }

  deleteConfig(key: string): void {
    const db = this.ensureDb()
    db.prepare("DELETE FROM app_config WHERE key = ?").run(key)
  }
}

export const statsStore = new StatsStore()
