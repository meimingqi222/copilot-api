// "解码 TPS"（首字后速率）的共享计算。
//
// 与 `usage_stats.tps` 的端到端口径不同：这里的耗时从**首个有效输出**算起，
// 不含首字等待（TTFT），等价于 1000/TPOT。三个性能视图（按模型 / 按供应商 /
// 按通道）必须共用同一套判定与钳位，否则同一份数据会算出三个不同的速率。

import type { RequestPerformance } from "~/lib/request-performance"
import type { UsageRawRow } from "~/lib/stats/types"

/**
 * 物理上限：当前没有上游能持续跑到 800 tok/s，超过即视为计时噪声
 * （典型来源是整段回答只落在极少帧里的突发流）。与前端 `formatTps` 的钳位一致。
 */
export const MAX_PLAUSIBLE_TPS = 800

export interface GenerationSample {
  tokens: number
  generationMs: number
}

/**
 * 该行的"首输出后"生成样本。返回 undefined 表示这行不参与解码 TPS：
 * 非流式行没有首输出边界，历史行没有 performance_json，零输出行没有意义。
 */
export function readGenerationSample(
  row: UsageRawRow,
): GenerationSample | undefined {
  const metrics = readRequestPerformance(row)
  if (!metrics) return undefined
  const generationMs = metrics.generationMs
  if (
    row.streaming !== 1
    || typeof generationMs !== "number"
    || !Number.isFinite(generationMs)
    || generationMs <= 0
    || row.completion_tokens <= 0
  )
    return undefined
  return {
    tokens: row.completion_tokens,
    generationMs: clampGenerationMs(row, generationMs),
  }
}

function clampGenerationMs(row: UsageRawRow, generationMs: number): number {
  const tokens = row.completion_tokens
  if (tokens / (generationMs / 1000) <= MAX_PLAUSIBLE_TPS) return generationMs
  // 单帧突发会把耗时压到几毫秒。优先用已持久化的端到端 TPS 反推真实耗时做
  // 平滑校准（它一定 >= 首输出后耗时），缺失时退回物理上限，避免速率爆表。
  const tps =
    typeof row.tps === "number" && row.tps > 0 && row.tps <= MAX_PLAUSIBLE_TPS ?
      row.tps
    : MAX_PLAUSIBLE_TPS
  return Math.max(generationMs, (tokens / tps) * 1000)
}

// 一次性能请求会把同一批行对象依次交给按模型 / 按供应商 / 按通道三个聚合函数，
// 用行对象身份缓存解析结果，避免同一段 JSON 被 parse 三遍。
const parsedByRow = new WeakMap<UsageRawRow, RequestPerformance | null>()

export function readRequestPerformance(
  row: UsageRawRow,
): RequestPerformance | undefined {
  const cached = parsedByRow.get(row)
  if (cached !== undefined) return cached ?? undefined
  const parsed = parseRequestPerformance(row.performance_json)
  parsedByRow.set(row, parsed ?? null)
  return parsed
}

function parseRequestPerformance(
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
