// 统计存储核心类（从 stats-store.ts 拆分而来，纯代码移动，无逻辑变更）
// StatsStore 作为门面，将各子模块的函数组合为带状态的实例方法。

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"

import type { ResolvedModelPricing } from "~/lib/models-dev"
import type { ProviderId } from "~/lib/provider-config"
import type {
  TimestampRangeUsage,
  UsageDayStats,
  UsageIntervalStats,
  UsageProviderStats,
  UsageStats,
} from "~/lib/stats/types"

import { PATHS } from "~/lib/paths"
import { deleteConfig, getConfig, setConfig } from "~/lib/stats/config"
import { getUsageStatsByIntervalData } from "~/lib/stats/interval"
import {
  getAllModelPricing,
  getModelPricing,
  getManualModelPricing,
  hasManualModelPricing,
  resolveModelPricing,
  setModelPricing,
} from "~/lib/stats/pricing"
import {
  getUsageByTimestampRangeData,
  getUsageStatsByProviderData,
  getUsageStatsData,
  getUsageStatsForUserData,
  getPerformanceByModelData,
} from "~/lib/stats/queries"
import { createTables } from "~/lib/stats/schema"

class StatsStore {
  private db: Database | null = null
  private isTestMode = false

  useTestDb(): void {
    this.isTestMode = true
    this.db = new Database(":memory:")
    createTables(this.db)
  }

  private ensureDb(): Database {
    if (this.db) return this.db
    if (this.isTestMode) {
      this.db = new Database(":memory:")
      createTables(this.db)
      return this.db
    }
    mkdirSync(path.dirname(PATHS.STATS_PATH), { recursive: true })
    this.db = new Database(PATHS.STATS_PATH)
    createTables(this.db)
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
        date, account_id, user_id, model, provider, connection_id, credential_id,
        prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, cost, timestamp, ttft_ms, tps, streaming
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      stats.date,
      stats.accountId,
      stats.userId ?? null,
      stats.model,
      stats.provider ?? null,
      stats.connectionId ?? null,
      stats.credentialId ?? null,
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
    return getUsageStatsForUserData(db, userId, startDate, endDate)
  }

  getUsageStats(
    accountId?: string,
    startDate?: string,
    endDate?: string,
  ): Array<UsageDayStats> {
    const db = this.ensureDb()
    return getUsageStatsData(db, accountId, startDate, endDate)
  }

  /**
   * Aggregate usage by provider -> account -> model directly from the DB.
   * Does NOT depend on the live account registry, so usage from deleted
   * accounts (provider backfilled/known) is still grouped under its provider.
   * Rows with a NULL provider (pre-migration, unbackfillable) map to "unknown".
   */
  getUsageStatsByProvider(
    startDate?: string,
    endDate?: string,
  ): Record<string, UsageProviderStats> {
    const db = this.ensureDb()
    return getUsageStatsByProviderData(db, startDate, endDate)
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
    return getUsageByTimestampRangeData(db, accountId, startMs, endMs)
  }

  getUsageStatsByInterval(
    intervalMinutes: number,
    accountId?: string,
    date?: string,
  ): Array<UsageIntervalStats> {
    const db = this.ensureDb()
    const effectiveDate = date ?? this.getDateString()
    return getUsageStatsByIntervalData(
      db,
      intervalMinutes,
      effectiveDate,
      accountId,
    )
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
    return getPerformanceByModelData(db, startDate, endDate)
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
    setModelPricing(db, model, pricing)
  }

  hasManualModelPricing(model: string): boolean {
    const db = this.ensureDb()
    return hasManualModelPricing(db, model)
  }

  getManualModelPricing(model: string): {
    promptPricePer1k: number
    completionPricePer1k: number
    cacheReadPricePer1k: number
    cacheWritePricePer1k: number
  } | null {
    const db = this.ensureDb()
    return getManualModelPricing(db, model)
  }

  resolveModelPricing(
    model: string,
    provider?: ProviderId,
  ): ResolvedModelPricing | null {
    const db = this.ensureDb()
    return resolveModelPricing(db, model, provider)
  }

  getModelPricing(
    model: string,
    provider?: ProviderId,
  ): {
    promptPricePer1k: number
    completionPricePer1k: number
    cacheReadPricePer1k: number
    cacheWritePricePer1k: number
  } | null {
    const db = this.ensureDb()
    return getModelPricing(db, model, provider)
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
    return getAllModelPricing(db)
  }

  getConfig(key: string): string | undefined {
    const db = this.ensureDb()
    return getConfig(db, key)
  }

  setConfig(key: string, value: string): void {
    const db = this.ensureDb()
    setConfig(db, key, value)
  }

  deleteConfig(key: string): void {
    const db = this.ensureDb()
    deleteConfig(db, key)
  }
}

export const statsStore = new StatsStore()
