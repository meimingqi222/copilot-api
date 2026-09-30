import type { Context } from "hono"

import type { RequestLogContext } from "~/lib/request-log"
import type {
  LossAction,
  LossRecord,
  LossReport,
  LossStage,
  IRWire,
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

const SAFE_REASONS: Readonly<Record<string, string>> = {
  "allowed_tools names an undeclared tool": "undeclared_allowed_tool",
  "required allowed_tools set is empty": "empty_required_tools",
  "tool names collide after target mapping": "tool_name_collision",
  "target cannot receive images": "images_unsupported",
  "target cannot receive tool-result images": "tool_result_images_unsupported",
  "move image to the following user content while retaining call order":
    "tool_image_repositioned",
  "target cannot receive file content": "files_unsupported",
  "file ID cannot be resolved by this target": "file_id_issuer_mismatch",
  "thinking text changed after signing": "signed_text_changed",
  "thinking signature belongs to another issuer": "signature_issuer_mismatch",
  "signature is not valid for the target wire": "signature_wire_mismatch",
  "target cannot replay Anthropic signature; retain readable reasoning only":
    "signature_not_replayed",
  "historical thinking without a valid signature cannot be replayed":
    "unsigned_thinking_dropped",
  "opaque reasoning cannot be replayed to another issuer":
    "encrypted_reasoning_issuer_mismatch",
  "target has no explicit cache breakpoint": "cache_breakpoint_unsupported",
  "target places its own cache breakpoints": "target_managed_cache",
  "flatten namespace with a reversible request-level mapping":
    "namespace_flattened",
  "target cannot enforce allowed tool subset":
    "allowed_tool_subset_unsupported",
  "filter declarations before applying target tool choice":
    "allowed_tools_filtered",
  "target has no native or orchestrated web search": "web_search_unsupported",
  "proxy runs the search loop against a search-capable account":
    "web_search_orchestrated",
  "target cannot perform a server-side tool call":
    "server_tool_use_unsupported",
  "historical server tool call cannot be replayed to this target":
    "server_tool_use_history_dropped",
  "target cannot receive web search results": "web_search_results_unsupported",
  "historical web search results cannot be replayed to this target":
    "web_search_results_history_dropped",
  "requested reasoning effort is unsupported by target model":
    "effort_unsupported_by_model",
  "reasoning effort mapped to nearest Messages level":
    "effort_mapped_to_messages",
  "reasoning effort represented by omitted Messages thinking config":
    "effort_omitted_for_messages",
  "Responses target cannot express requested reasoning effort":
    "effort_unsupported_by_responses",
}

export interface SafeLossRecord {
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

export function sanitizeLossRecord(record: LossRecord): SafeLossRecord {
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
    reason: SAFE_REASONS[record.reason] ?? "unspecified",
    target:
      ["chat", "messages", "responses", "gemini"].includes(record.target) ?
        record.target
      : "chat",
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
