import type { Context } from "hono"

import type { RequestLogContext } from "~/lib/request-log"
import { lossReasonCode } from "./loss-reasons"
import {
  isIRWire,
  type IRWire,
  type LossAction,
  type LossRecord,
  type LossReport,
  type LossStage,
} from "./types"

import { logger } from "~/lib/logger"
import { getRequestLogContext } from "~/lib/request-log"

const MAX_RECORDS_PER_REQUEST = 64
const MAX_METRIC_SERIES = 512

/** Only structural paths are retained; values and arbitrary object keys are erased. */
const SAFE_PATH =
  /^(?:instructions|turns|tools|parts|output|toolChoice|generation)(?:\[\d{1,5}\]|\.(?:parts|content|source|reasoning|effort|webSearch|textFormat|toolChoice)(?:\[\d{1,5}\])?)*$/

const SAFE_FEATURES = new Set([
  "image",
  "tool_result_image",
  "file",
  "file_id",
  "signed_thinking",
  "unsigned_thinking",
  "encrypted_reasoning",
  "cache_control",
  "namespace_tool",
  "allowed_tools",
  "web_search",
  "server_tool_use",
  "web_search_result",
  "reasoning_effort",
  "tool_choice",
  "usage",
  "stop_reason",
  "unknown_field",
])

interface SafeLossRecord {
  path: string
  feature: string
  action: LossAction
  reason: string
  target: IRWire
  stage: LossStage
}

interface RequestLossState {
  records: Array<SafeLossRecord>
  seen: Set<string>
}

const pending = new WeakMap<RequestLogContext, RequestLossState>()
const metricCounts = new Map<string, number>()

function sanitizeLossRecord(record: LossRecord): SafeLossRecord {
  return {
    path:
      record.path.length <= 128 && SAFE_PATH.test(record.path) ?
        record.path
      : "unknown",
    feature: SAFE_FEATURES.has(record.feature) ? record.feature : "unknown",
    action:
      ["transform", "synthesize", "drop", "reject"].includes(record.action) ?
        record.action
      : "drop",
    reason: lossReasonCode(record.reason),
    target: isIRWire(record.target) ? record.target : "chat",
    stage:
      (
        [
          "decode",
          "preflight",
          "encode_request",
          "decode_response",
          "encode_response",
        ].includes(record.stage)
      ) ?
        record.stage
      : "preflight",
  }
}

/** Called by cross-protocol wrappers after preflight and after encoding. */
export function recordTranslationLosses(
  c: Context | undefined,
  report: LossReport,
): void {
  if (!c) return
  recordTranslationLossesForContext(getRequestLogContext(c), report)
}

/** Explicit-context form for a detached request or a WebSocket turn. */
export function recordTranslationLossesForContext(
  ctx: RequestLogContext | undefined,
  report: LossReport,
): void {
  if (!ctx || ctx.finished) return
  const state = pending.get(ctx) ?? { records: [], seen: new Set<string>() }
  pending.set(ctx, state)
  for (const raw of report.records) {
    if (raw.action === "preserve") continue
    const safe = sanitizeLossRecord(raw)
    const key = JSON.stringify(safe)
    if (state.seen.has(key)) continue
    state.seen.add(key)
    if (state.records.length >= MAX_RECORDS_PER_REQUEST) continue
    state.records.push(safe)
    const metricKey = JSON.stringify({
      feature: safe.feature,
      action: safe.action,
      reason: safe.reason,
      target: safe.target,
    })
    if (metricCounts.has(metricKey) || metricCounts.size < MAX_METRIC_SERIES) {
      metricCounts.set(metricKey, (metricCounts.get(metricKey) ?? 0) + 1)
    }
  }
}

export function getTranslationLossesForContext(
  ctx: RequestLogContext,
): ReadonlyArray<SafeLossRecord> {
  return pending.get(ctx)?.records ?? []
}

/** Flushes once when the existing request log is finalized; LogEntry stays unchanged. */
export function flushTranslationLossesForContext(
  ctx: RequestLogContext | undefined,
): void {
  if (!ctx) return
  const state = pending.get(ctx)
  if (!state) return
  pending.delete(ctx)
  if (state.records.length === 0) return
  logger.info("[protocol-ir] translation losses", {
    requestId: ctx.requestId,
    count: state.records.length,
    records: state.records,
  })
}

export function getTranslationLossMetricsSnapshot(): Array<{
  feature: string
  action: LossAction
  reason: string
  target: IRWire
  count: number
}> {
  return Array.from(metricCounts, ([key, count]) => ({
    ...(JSON.parse(key) as Omit<SafeLossRecord, "path" | "stage">),
    count,
  }))
}

export function resetTranslationLossMetricsForTest(): void {
  metricCounts.clear()
}
