// Timestamp-range usage aggregation grouped in the viewer's timezone.
// Unlike the `date`-column queries in queries.ts (server-local day), every
// grouping here keys off the exact UTC `timestamp` so dashboard days match
// the browser's local days even when the server is in another timezone.

import type {
  UsageDayStats,
  UsageIntervalStats,
  UsageModelStats,
  UsageProviderStats,
  UsageRawRow,
} from "~/lib/stats/types"

import { formatDateInTimeZone, resolveTimeZone } from "~/lib/stats/timezone"

function emptyModelStats(): UsageModelStats {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  }
}

function addRowToModelStats(target: UsageModelStats, row: UsageRawRow): void {
  target.requests += 1
  target.promptTokens += row.prompt_tokens
  target.completionTokens += row.completion_tokens
  target.cacheReadTokens += row.cache_read_tokens
  target.cacheWriteTokens += row.cache_write_tokens
  target.totalTokens += row.total_tokens
  target.cost += row.cost
}

/** Group raw rows by viewer date (DESC, matching the legacy day query). */
export function groupRowsByViewerDate(
  rows: Array<UsageRawRow>,
  tz: string,
): Array<UsageDayStats> {
  const timeZone = resolveTimeZone(tz)
  const byDate = new Map<string, UsageDayStats>()
  for (const row of rows) {
    const date = formatDateInTimeZone(row.timestamp, timeZone)
    let day = byDate.get(date)
    if (!day) {
      day = { date, ...emptyModelStats(), models: {} }
      byDate.set(date, day)
    }
    addRowToModelStats(day, row)
    const modelKey = row.model || "unknown"
    const modelStats = day.models[modelKey] ?? emptyModelStats()
    addRowToModelStats(modelStats, row)
    day.models[modelKey] = modelStats
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date))
}

/** Provider -> account -> model nesting, mirroring getUsageStatsByProviderData. */
export function groupRowsByProvider(
  rows: Array<UsageRawRow>,
): Record<string, UsageProviderStats> {
  const result: Record<string, UsageProviderStats> = {}
  for (const row of rows) {
    const providerKey = row.provider ?? "unknown"
    let provider = result[providerKey]
    if (!provider) {
      provider = {
        label: providerKey,
        ...emptyModelStats(),
        accounts: {},
      }
      result[providerKey] = provider
    }
    let account = provider.accounts[row.account_id]
    if (!account) {
      account = { label: row.account_id, ...emptyModelStats(), models: {} }
      provider.accounts[row.account_id] = account
    }
    addRowToModelStats(provider, row)
    addRowToModelStats(account, row)
    const modelKey = row.model || "unknown"
    const modelStats = account.models[modelKey] ?? emptyModelStats()
    addRowToModelStats(modelStats, row)
    account.models[modelKey] = modelStats
  }
  return result
}

export interface PerformanceByModel {
  model: string
  requests: number
  streamingRequests: number
  avgTtftMs: number | null
  avgStreamingTps: number | null
  avgNonStreamingTps: number | null
}

/** Per-model TTFT/TPS averages, mirroring getPerformanceByModelData. */
export function computePerformanceByModel(
  rows: Array<UsageRawRow>,
): Array<PerformanceByModel> {
  interface Accumulator {
    model: string
    requests: number
    streamingRequests: number
    ttftSum: number
    ttftCount: number
    streamTokens: number
    streamTokenSeconds: number
    nonStreamTokens: number
    nonStreamTokenSeconds: number
  }
  const byModel = new Map<string, Accumulator>()
  for (const row of rows) {
    if (row.ttft_ms === null && row.tps === null) continue
    let acc = byModel.get(row.model)
    if (!acc) {
      acc = {
        model: row.model,
        requests: 0,
        streamingRequests: 0,
        ttftSum: 0,
        ttftCount: 0,
        streamTokens: 0,
        streamTokenSeconds: 0,
        nonStreamTokens: 0,
        nonStreamTokenSeconds: 0,
      }
      byModel.set(row.model, acc)
    }
    acc.requests += 1
    if (row.streaming === 1) acc.streamingRequests += 1
    if (row.ttft_ms !== null) {
      acc.ttftSum += row.ttft_ms
      acc.ttftCount += 1
    }
    if (row.tps !== null && row.tps > 0) {
      const seconds = row.completion_tokens / row.tps
      if (row.streaming === 1) {
        acc.streamTokens += row.completion_tokens
        acc.streamTokenSeconds += seconds
      } else if (row.streaming === 0) {
        acc.nonStreamTokens += row.completion_tokens
        acc.nonStreamTokenSeconds += seconds
      }
    }
  }
  return [...byModel.values()]
    .sort((a, b) => b.requests - a.requests)
    .map((acc) => ({
      model: acc.model,
      requests: acc.requests,
      streamingRequests: acc.streamingRequests,
      avgTtftMs: acc.ttftCount > 0 ? acc.ttftSum / acc.ttftCount : null,
      avgStreamingTps:
        acc.streamTokenSeconds > 0 ?
          acc.streamTokens / acc.streamTokenSeconds
        : null,
      avgNonStreamingTps:
        acc.nonStreamTokenSeconds > 0 ?
          acc.nonStreamTokens / acc.nonStreamTokenSeconds
        : null,
    }))
}

export interface IntervalBucketOptions {
  rows: Array<UsageRawRow>
  intervalMs: number
  /** Slots align to this instant (viewer midnight); defaults to UTC midnight. */
  alignMs?: number
}

/** Fixed-width time buckets with per-model breakdowns, ascending by slot. */
export function bucketRowsByInterval(
  options: IntervalBucketOptions,
): Array<UsageIntervalStats> {
  const { rows, intervalMs } = options
  const alignMs = options.alignMs ?? 0
  const slots = new Map<number, UsageIntervalStats>()
  for (const row of rows) {
    const slotTs =
      alignMs + Math.floor((row.timestamp - alignMs) / intervalMs) * intervalMs
    let slot = slots.get(slotTs)
    if (!slot) {
      slot = { slotTs, ...emptyModelStats(), models: {} }
      slots.set(slotTs, slot)
    }
    addRowToModelStats(slot, row)
    const modelKey = row.model || "unknown"
    const modelStats = slot.models[modelKey] ?? emptyModelStats()
    addRowToModelStats(modelStats, row)
    slot.models[modelKey] = modelStats
  }
  return [...slots.values()].sort((a, b) => a.slotTs - b.slotTs)
}
