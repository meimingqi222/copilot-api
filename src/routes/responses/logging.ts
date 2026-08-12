import type { ResponsesResponse } from "~/services/copilot/responses-api"

export type ResponsesLogOutcome = "success" | "incomplete" | "failed"

export const LEADING_RESPONSES_CONTROL_TYPES = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
])

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
