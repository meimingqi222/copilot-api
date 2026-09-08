import type { ResponsesResponse } from "~/services/copilot/responses-api"

import { sanitizeDiagnosticSnippet } from "~/lib/security-sanitizer"

export type ResponsesLogOutcome = "success" | "incomplete" | "failed"

export const TERMINAL_RESPONSE_TYPES = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
])

export function getResponsesStatusOutcome(
  status: ResponsesResponse["status"],
): ResponsesLogOutcome {
  if (status === "failed") return "failed"
  if (status === "incomplete" || status === "in_progress") return "incomplete"
  return "success"
}

export function hasResponsesOutput(response: ResponsesResponse): boolean {
  return Boolean(
    hasNonEmptyString(response.output_text)
      || response.output?.some((item) => hasResponsesOutputItem(item)),
  )
}

export function isResponsesOutputEvent(
  event: Record<string, unknown>,
): boolean {
  const type = typeof event.type === "string" ? event.type : ""
  if (type.endsWith(".delta")) {
    return hasMeaningfulValue(event.delta)
  }
  if (type.startsWith("response.output_item.")) {
    return hasResponsesOutputItem(event.item)
  }
  if (
    type.startsWith("response.content_part.")
    || type.startsWith("response.reasoning_summary_part.")
  ) {
    return hasResponsesContentPart(event.part)
  }
  if (type.endsWith(".done")) {
    return (
      hasNonEmptyString(event.text)
      || hasNonEmptyString(event.refusal)
      || hasNonEmptyString(event.arguments)
      || hasNonEmptyString(event.transcript)
    )
  }
  return false
}

function hasResponsesOutputItem(value: unknown): boolean {
  const item = asRecord(value)
  if (!item) return false

  if (item.type === "message") {
    return (
      Array.isArray(item.content)
      && item.content.some((part) => hasResponsesContentPart(part))
    )
  }
  if (item.type === "reasoning") {
    return (
      Array.isArray(item.summary)
      && item.summary.some((part) => hasResponsesContentPart(part))
    )
  }
  if (
    item.type === "function_call"
    || item.type === "custom_tool_call"
    || item.type === "mcp_call"
  ) {
    return (
      hasNonEmptyString(item.name)
      || hasNonEmptyString(item.arguments)
      || hasMeaningfulValue(item.input)
    )
  }
  return false
}

function hasResponsesContentPart(value: unknown): boolean {
  const part = asRecord(value)
  if (!part) return false
  return (
    hasNonEmptyString(part.text)
    || hasNonEmptyString(part.refusal)
    || hasNonEmptyString(part.transcript)
  )
}

function hasMeaningfulValue(value: unknown): boolean {
  if (hasNonEmptyString(value)) return true
  if (Array.isArray(value)) return value.length > 0
  return Boolean(
    value && typeof value === "object" && Object.keys(value).length > 0,
  )
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ?
      (value as Record<string, unknown>)
    : undefined
}

/**
 * 从流内终止失败事件里提取人类可读的错误摘要，持久化进请求日志。
 *
 * 背景：流成功打开（上游 200）后再失败的 turn，错误只存在于 SSE 事件里，
 * 此前没有任何落盘位置——后台只能看到 `response.failed` + 零输出，
 * 无法定位是配额、上下文还是脏历史的问题。
 *
 * 覆盖两种形态：
 * - `{"type":"error","code","message"}`（标准错误事件）
 * - `{"type":"response.failed","response":{"error":{...}}}`（压缩/推理失败）
 */
export function extractStreamFailureDetail(
  event: Record<string, unknown>,
): string | undefined {
  const pick = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined
  const response = asRecord(event.response)
  const error = asRecord(event.error) ?? asRecord(response?.error)
  const message =
    pick(error?.message) ?? pick(response?.message) ?? pick(event.message)
  const code =
    pick(error?.code)
    ?? pick(error?.type)
    ?? pick(event.code)
    ?? pick(response?.status)
  let detail: string | undefined
  if (message) {
    detail = code ? `${code}: ${message}` : message
  } else if (code) {
    detail = `upstream stream failed (${code})`
  }
  if (!detail) return undefined
  return detail.length > 500 ? `${detail.slice(0, 497)}…` : detail
}

/** `patchRequestLog` 能直接消费的流失败补丁形态（LogEntry 子集）。 */
export interface StreamFailurePatch {
  error: string
  errorType: "upstream_stream_error"
  errorSnippet: string | undefined
  outcome: "failed"
  diagnosticError: {
    origin: "upstream"
    kind: "stream_failed"
    message: string
  }
}

/**
 * 由流内终止失败事件构造请求日志补丁；无可报告内容时返回 undefined。
 * 纯函数：覆盖 `response.failed` / `error` 两种事件形态，
 * 错误原文经脱敏 + 截断后同时写入 error 全文与 diagnosticError。
 */
export function buildStreamFailurePatch(
  event: Record<string, unknown>,
): StreamFailurePatch | undefined {
  const failureDetail = extractStreamFailureDetail(event)
  if (!failureDetail) return undefined
  const message =
    failureDetail.length > 500 ?
      `${failureDetail.slice(0, 497)}…`
    : failureDetail
  return {
    error: failureDetail,
    errorType: "upstream_stream_error",
    errorSnippet: sanitizeDiagnosticSnippet(failureDetail),
    outcome: "failed",
    diagnosticError: {
      origin: "upstream",
      kind: "stream_failed",
      message,
    },
  }
}
