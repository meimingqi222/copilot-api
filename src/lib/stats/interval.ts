// 按时间区间聚合的使用统计逻辑（从 stats-store.ts 拆分而来，纯代码移动，无逻辑变更）

import { Database } from "bun:sqlite"

import type { UsageIntervalStats } from "~/lib/stats/types"

export function getUsageStatsByIntervalData(
  db: Database,
  intervalMinutes: number,
  effectiveDate: string,
  accountId?: string,
): Array<UsageIntervalStats> {
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
  const params: Array<string | number> = [intervalMs, intervalMs, effectiveDate]

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
      completionTokens: existingModel.completionTokens + row.completion_tokens,
      cacheReadTokens: existingModel.cacheReadTokens + row.cache_read_tokens,
      cacheWriteTokens: existingModel.cacheWriteTokens + row.cache_write_tokens,
      totalTokens: existingModel.totalTokens + row.total_tokens,
      cost: existingModel.cost + row.cost,
    }
  }

  return Object.values(slotMap).sort((a, b) => a.slotTs - b.slotTs)
}
