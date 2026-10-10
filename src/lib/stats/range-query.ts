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
import { readGenerationSample } from "~/lib/stats/performance-generation"
import {
  providerBucketKey,
  providerBucketLabel,
} from "~/lib/stats/provider-labels"

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

interface PerformanceByModel {
  model: string
  requests: number
  streamingRequests: number
  avgTtftMs: number | null
  /** 端到端：tokens / (dispatch → 记账)，含首字等待与上游排队。 */
  avgStreamingTps: number | null
  /** 解码：tokens / (首个有效输出 → 记账)，不含首字等待，等价于 1000/TPOT。 */
  avgDecodeTps: number | null
  /** 参与 avgDecodeTps 的样本数（仅已采集分段性能的流式请求）。 */
  decodeSamples: number
  avgNonStreamingTps: number | null
}

/**
 * Per-model TTFT/TPS averages.
 *
 * A model is listed once it has at least one timed request, but `requests` /
 * `streamingRequests` count *every* row of that model — including rows with no
 * timing data (an aborted stream that reported no usage, a usage-missing
 * fallback). The count therefore matches the usage table instead of only the
 * timed subset, while the averages still ignore untimed rows.
 *
 * `avgDecodeTps` / `decodeSamples` come from versioned `performance_json`, so
 * their coverage is narrower than `avgStreamingTps` (legacy rows have no
 * first-output boundary). `decodeSamples` reports that coverage.
 */
export function computePerformanceByModel(
  rows: Array<UsageRawRow>,
): Array<PerformanceByModel> {
  const timedModels = new Set<string>()
  for (const row of rows) {
    if (row.ttft_ms !== null || row.tps !== null) timedModels.add(row.model)
  }
  const byModel = new Map<string, PerfAccumulator>()
  for (const row of rows) {
    if (!timedModels.has(row.model)) continue
    let acc = byModel.get(row.model)
    if (!acc) {
      acc = newPerfAccumulator()
      byModel.set(row.model, acc)
    }
    accumulatePerfRow(acc, row)
  }
  return [...byModel.entries()]
    .sort(([, left], [, right]) => right.requests - left.requests)
    .map(([model, acc]) => ({ model, ...perfAverages(acc) }))
}

interface PerformanceByProviderModel extends PerformanceByModel {
  /**
   * 汇总键。account-managed 是 provider id；plain connection 是
   * `connection:<id>`（见 provider-labels）。
   */
  provider: string
  /** 原始 `provider` 列值（plain connection 即 protocol），用于标签回退。 */
  providerId: string
}

/**
 * Per-(provider, model) TTFT/TPS averages.同一模型在不同 provider
 * 的速度可能差很大，聚合时不能只按 model 分组。
 *
 * plain connection 按 connection 而不是 protocol 分组：否则 DeepSeek、火山
 * 引擎、AiHubMix 全部塌进同一个 `openai-compatible` 桶，既分不清是谁，也
 * 把各家的延迟混在一起求均值（见 lib/stats/provider-labels）。
 *
 * Same counting rule as `computePerformanceByModel`: a (provider, model) pair
 * is listed once it has a timed request, and then counts all of its rows.
 */
export function computePerformanceByProviderModel(
  rows: Array<UsageRawRow>,
): Array<PerformanceByProviderModel> {
  // 每行的汇总键只算一次：providerBucketKey 会查连接注册表，而旧实现把
  // keyOf 调了三次（建 timedKeys 一遍、聚合一遍、键内再算一遍）。
  const keys = rows.map((row) => providerBucketKey(row))
  const timedKeys = new Set<string>()
  for (const [index, row] of rows.entries()) {
    if (row.ttft_ms !== null || row.tps !== null) {
      timedKeys.add(keys[index] + "\0" + row.model)
    }
  }
  const byKey = new Map<
    string,
    {
      acc: PerfAccumulator
      provider: string
      providerId: string
      model: string
    }
  >()
  for (const [index, row] of rows.entries()) {
    const key = keys[index] + "\0" + row.model
    if (!timedKeys.has(key)) continue
    const provider = keys[index]
    const providerId = row.provider ?? "unknown"
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        acc: newPerfAccumulator(),
        provider,
        providerId,
        model: row.model,
      }
      byKey.set(key, entry)
    }
    accumulatePerfRow(entry.acc, row)
  }
  return [...byKey.values()]
    .sort((left, right) => right.acc.requests - left.acc.requests)
    .map(({ acc, provider, providerId, model }) => ({
      provider,
      providerId,
      model,
      ...perfAverages(acc),
    }))
}

interface PerfAccumulator {
  requests: number
  streamingRequests: number
  ttftSum: number
  ttftCount: number
  streamTokens: number
  streamTokenSeconds: number
  nonStreamTokens: number
  nonStreamTokenSeconds: number
  decodeTokens: number
  decodeMs: number
  decodeSamples: number
}

function newPerfAccumulator(): PerfAccumulator {
  return {
    requests: 0,
    streamingRequests: 0,
    ttftSum: 0,
    ttftCount: 0,
    streamTokens: 0,
    streamTokenSeconds: 0,
    nonStreamTokens: 0,
    nonStreamTokenSeconds: 0,
    decodeTokens: 0,
    decodeMs: 0,
    decodeSamples: 0,
  }
}

function accumulatePerfRow(acc: PerfAccumulator, row: UsageRawRow): void {
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
  const decode = readGenerationSample(row)
  if (decode) {
    acc.decodeSamples += 1
    acc.decodeTokens += decode.tokens
    acc.decodeMs += decode.generationMs
  }
}

function perfAverages(acc: PerfAccumulator): {
  requests: number
  streamingRequests: number
  avgTtftMs: number | null
  avgStreamingTps: number | null
  avgDecodeTps: number | null
  decodeSamples: number
  avgNonStreamingTps: number | null
} {
  return {
    requests: acc.requests,
    streamingRequests: acc.streamingRequests,
    avgTtftMs: acc.ttftCount > 0 ? acc.ttftSum / acc.ttftCount : null,
    avgStreamingTps:
      acc.streamTokenSeconds > 0 ?
        acc.streamTokens / acc.streamTokenSeconds
      : null,
    avgDecodeTps:
      acc.decodeMs > 0 ? acc.decodeTokens / (acc.decodeMs / 1000) : null,
    decodeSamples: acc.decodeSamples,
    avgNonStreamingTps:
      acc.nonStreamTokenSeconds > 0 ?
        acc.nonStreamTokens / acc.nonStreamTokenSeconds
      : null,
  }
}

interface IntervalBucketOptions {
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

interface PerformanceTrendSlot {
  slotTs: number
  requests: number
  streamingRequests: number
  avgTtftMs: number | null
  avgStreamingTps: number | null
  avgDecodeTps: number | null
  decodeSamples: number
  avgNonStreamingTps: number | null
}

interface PerformanceTrendProviderSeries {
  provider: string
  providerLabel: string
  series: Array<PerformanceTrendSlot>
}

export interface PerformanceTrendResult {
  model?: string
  provider?: string
  intervalMinutes: number
  series: Array<PerformanceTrendSlot>
  byProvider?: Array<PerformanceTrendProviderSeries>
}

export function computePerformanceTrend(options: {
  rows: Array<UsageRawRow>
  startMs: number
  endMs: number
  intervalMinutes: number
  model?: string
  provider?: string
  alignMs?: number
}): PerformanceTrendResult {
  const { rows, startMs, endMs, model, provider } = options
  let intervalMinutes = Math.max(1, options.intervalMinutes)
  let intervalMs = intervalMinutes * 60 * 1000
  const align = options.alignMs ?? 0

  const effectiveEnd = Math.max(startMs, endMs)
  let effectiveStartMs =
    startMs > 0 ? startMs : (
      (rows[0]?.timestamp ?? Math.max(0, effectiveEnd - 7 * 86_400_000))
    )

  if (effectiveEnd - effectiveStartMs < intervalMs) {
    effectiveStartMs = Math.max(0, effectiveEnd - intervalMs)
  }

  // 避免跨度过长导致 slot 过多（上限 ~180 个点）
  while ((effectiveEnd - effectiveStartMs) / intervalMs > 180) {
    intervalMinutes *= 2
    intervalMs = intervalMinutes * 60 * 1000
  }

  const firstSlot =
    align + Math.floor((effectiveStartMs - align) / intervalMs) * intervalMs
  const lastSlot =
    align
    + Math.floor(
      (Math.max(effectiveStartMs, effectiveEnd - 1) - align) / intervalMs,
    )
      * intervalMs

  const slotTimestamps: number[] = []
  for (let t = firstSlot; t <= lastSlot; t += intervalMs) {
    slotTimestamps.push(t)
  }

  // 总体 slot 累加器
  const overallSlots = new Map<number, PerfAccumulator>()
  for (const t of slotTimestamps) {
    overallSlots.set(t, newPerfAccumulator())
  }

  // 分 provider 累加器映射
  const providerIds = new Map<string, string>()
  const providerSlots = new Map<string, Map<number, PerfAccumulator>>()

  for (const row of rows) {
    const slotTs =
      align + Math.floor((row.timestamp - align) / intervalMs) * intervalMs
    const overallAcc = overallSlots.get(slotTs)
    if (overallAcc) {
      accumulatePerfRow(overallAcc, row)
    }

    const pKey = providerBucketKey(row)
    if (!providerIds.has(pKey)) {
      providerIds.set(pKey, row.provider ?? "unknown")
    }
    let pSlotMap = providerSlots.get(pKey)
    if (!pSlotMap) {
      pSlotMap = new Map<number, PerfAccumulator>()
      for (const t of slotTimestamps) {
        pSlotMap.set(t, newPerfAccumulator())
      }
      providerSlots.set(pKey, pSlotMap)
    }
    const pAcc = pSlotMap.get(slotTs)
    if (pAcc) {
      accumulatePerfRow(pAcc, row)
    }
  }

  const series: Array<PerformanceTrendSlot> = slotTimestamps.map((slotTs) => ({
    slotTs,
    ...perfAverages(overallSlots.get(slotTs)!),
  }))

  let byProvider: Array<PerformanceTrendProviderSeries> | undefined
  if (!provider && providerSlots.size > 1) {
    byProvider = [...providerSlots.entries()]
      .map(([pKey, pSlotMap]) => {
        const rawId = providerIds.get(pKey) ?? "unknown"
        const pSeries = slotTimestamps.map((slotTs) => ({
          slotTs,
          ...perfAverages(pSlotMap.get(slotTs)!),
        }))
        return {
          provider: pKey,
          providerLabel: providerBucketLabel(pKey, rawId),
          series: pSeries,
        }
      })
      .sort((a, b) => {
        const reqA = a.series.reduce((sum, s) => sum + s.requests, 0)
        const reqB = b.series.reduce((sum, s) => sum + s.requests, 0)
        return reqB - reqA
      })
  }

  return {
    model,
    provider,
    intervalMinutes,
    series,
    byProvider,
  }
}
