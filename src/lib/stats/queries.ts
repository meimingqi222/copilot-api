// 使用统计查询函数（从 stats-store.ts 拆分而来，纯代码移动，无逻辑变更）

import { Database } from "bun:sqlite"

import type {
  TimestampRangeUsage,
  UsageDayRow,
  UsageDayStats,
  UsageModelRow,
  UsageModelStats,
  UsageProviderRow,
  UsageProviderStats,
  ProviderAccountUsage,
} from "~/lib/stats/types"

export function queryUsageDayRows(
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

export function queryUsageModelsByDate(
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

export function getUsageStatsForUserData(
  db: Database,
  userId: string,
  startDate?: string,
  endDate?: string,
): Array<UsageDayStats> {
  const rows = queryUsageDayRows(db, {
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
    models: queryUsageModelsByDate(db, row.date, undefined, userId),
  }))
}

export function getUsageStatsData(
  db: Database,
  accountId?: string,
  startDate?: string,
  endDate?: string,
): Array<UsageDayStats> {
  const rows = queryUsageDayRows(db, {
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
    models: queryUsageModelsByDate(db, row.date, accountId),
  }))
}

/**
 * Aggregate usage by provider -> account -> model directly from the DB.
 * Does NOT depend on the live account registry, so usage from deleted
 * accounts (provider backfilled/known) is still grouped under its provider.
 * Rows with a NULL provider (pre-migration, unbackfillable) map to "unknown".
 */
export function getUsageStatsByProviderData(
  db: Database,
  startDate?: string,
  endDate?: string,
): Record<string, UsageProviderStats> {
  let query = `
    SELECT
      provider,
      account_id,
      model,
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
  if (startDate) {
    query += " AND date >= ?"
    params.push(startDate)
  }
  if (endDate) {
    query += " AND date <= ?"
    params.push(endDate)
  }
  query += " GROUP BY provider, account_id, model"

  const rows = db.prepare(query).all(...params) as Array<UsageProviderRow>

  const result: Record<string, UsageProviderStats> = {}
  const ensureProvider = (providerKey: string): UsageProviderStats => {
    if (!(providerKey in result)) {
      result[providerKey] = {
        label: providerKey,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 0,
        accounts: {},
      }
    }
    return result[providerKey]
  }
  const ensureAccount = (
    provider: UsageProviderStats,
    accountId: string,
  ): ProviderAccountUsage => {
    if (!(accountId in provider.accounts)) {
      provider.accounts[accountId] = {
        label: accountId,
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
    return provider.accounts[accountId]
  }

  for (const row of rows) {
    const providerKey = row.provider ?? "unknown"
    const provider = ensureProvider(providerKey)
    const account = ensureAccount(provider, row.account_id)
    const metrics = {
      requests: row.requests,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens: row.total_tokens,
      cost: row.cost,
    }
    provider.requests += metrics.requests
    provider.promptTokens += metrics.promptTokens
    provider.completionTokens += metrics.completionTokens
    provider.cacheReadTokens += metrics.cacheReadTokens
    provider.cacheWriteTokens += metrics.cacheWriteTokens
    provider.totalTokens += metrics.totalTokens
    provider.cost += metrics.cost
    account.requests += metrics.requests
    account.promptTokens += metrics.promptTokens
    account.completionTokens += metrics.completionTokens
    account.cacheReadTokens += metrics.cacheReadTokens
    account.cacheWriteTokens += metrics.cacheWriteTokens
    account.totalTokens += metrics.totalTokens
    account.cost += metrics.cost
    account.models[row.model] = metrics
  }

  return result
}

export function getUsageByTimestampRangeData(
  db: Database,
  accountId: string,
  startMs: number,
  endMs: number,
): TimestampRangeUsage {
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

export function getPerformanceByModelData(
  db: Database,
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
