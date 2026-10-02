import type { RequestPerformance } from "~/lib/request-performance"
import type { UsageRawRow } from "~/lib/stats/types"

const TIMING_FIELDS = [
  "outputTtftMs",
  "textTtftMs",
  "firstWriteMs",
  "preprocessingMs",
  "bodyParseMs",
  "bodyReadMs",
  "jsonDecodeMs",
  "admissionMs",
  "routingDecisionMs",
  "tokenEstimateMs",
  "dispatchToOutputMs",
  "requestTranslationMs",
  "firstTranslatedFrameMs",
  "rateLimitWaitMs",
  "failedAttemptMs",
  "upstreamHeadersMs",
  "upstreamConnectMs",
  "upstreamQueueMs",
  "upstreamFirstEventMs",
  "upstreamBodyReadMs",
  "adapterPreparationMs",
  "responseTranslationMs",
  "streamTranslationActiveMs",
  "downstreamWriteMs",
  "outputToWriteMs",
  "upstreamToOutputMs",
  "responseReadyMs",
] as const

type TimingField = (typeof TIMING_FIELDS)[number]

export interface TimingSummary {
  samples: number
  average: number | null
  p50: number | null
  p95: number | null
}

export interface PerformanceDetail {
  provider: string
  model: string
  endpoint: string
  transport: string
  translated: boolean
  streaming: boolean
  requests: number
  generationSamples: number
  generationTps: number | null
  timings: Record<TimingField, TimingSummary>
}

interface DetailAccumulator {
  identity: Omit<
    PerformanceDetail,
    "requests" | "generationSamples" | "generationTps" | "timings"
  >
  requests: number
  generationSamples: number
  tokens: number
  generationMs: number
  timings: Record<TimingField, number[]>
}

export function summarizeTimings(values: number[]): TimingSummary {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right)
  if (!sorted.length) return { samples: 0, average: null, p50: null, p95: null }
  const percentile = (fraction: number) =>
    sorted[Math.ceil(sorted.length * fraction) - 1] ?? null
  return {
    samples: sorted.length,
    average: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
  }
}

export function computePerformanceDetails(
  rows: UsageRawRow[],
): PerformanceDetail[] {
  const groups = new Map<string, DetailAccumulator>()
  for (const row of rows) {
    const metrics = readPerformance(row.performance_json)
    if (!metrics) continue
    const identity = {
      provider: row.provider ?? "unknown",
      model: row.model,
      endpoint: metrics.endpoint,
      transport: metrics.transport,
      translated: metrics.translated,
      streaming: row.streaming === 1,
    }
    const key = JSON.stringify(identity)
    let group = groups.get(key)
    if (!group) {
      group = {
        identity,
        requests: 0,
        generationSamples: 0,
        tokens: 0,
        generationMs: 0,
        timings: Object.fromEntries(
          TIMING_FIELDS.map((field) => [field, [] as number[]]),
        ) as Record<TimingField, number[]>,
      }
      groups.set(key, group)
    }
    group.requests += 1
    for (const field of TIMING_FIELDS) {
      const value = metrics[field]
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        group.timings[field].push(value)
    }
    if (
      row.streaming === 1
      && typeof metrics.generationMs === "number"
      && Number.isFinite(metrics.generationMs)
      && metrics.generationMs > 0
      && row.completion_tokens > 0
    ) {
      group.generationSamples += 1
      group.tokens += row.completion_tokens
      group.generationMs += metrics.generationMs
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group.identity,
      requests: group.requests,
      generationSamples: group.generationSamples,
      generationTps:
        group.generationMs > 0 ?
          group.tokens / (group.generationMs / 1000)
        : null,
      timings: Object.fromEntries(
        TIMING_FIELDS.map((field) => [
          field,
          summarizeTimings(group.timings[field]),
        ]),
      ) as Record<TimingField, TimingSummary>,
    }))
    .sort((left, right) => right.requests - left.requests)
}

function readPerformance(
  raw: string | null | undefined,
): RequestPerformance | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<RequestPerformance> | null
    if (
      value?.version !== 1
      || typeof value.endpoint !== "string"
      || (value.transport !== "http" && value.transport !== "ws")
      || typeof value.translated !== "boolean"
    )
      return undefined
    return value as RequestPerformance
  } catch {
    return undefined
  }
}
