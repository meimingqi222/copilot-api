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
  return Boolean(response.output_text || response.output?.length)
}

export function isResponsesOutputEvent(
  event: Record<string, unknown>,
): boolean {
  const type = typeof event.type === "string" ? event.type : ""
  return (
    type.startsWith("response.output_item.")
    || type.startsWith("response.content_part.")
    || type.includes(".delta")
  )
}
