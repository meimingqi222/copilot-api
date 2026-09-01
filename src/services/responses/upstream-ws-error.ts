import { HTTPError } from "~/lib/error"

/** Extract an actionable message from top-level or response.failed payloads. */
export function extractWsErrorMessage(parsed: Record<string, unknown>): string {
  const error = readWsErrorPayload(parsed)
  if (error) {
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message
    }
    if (typeof error.code === "string" && error.code.trim()) return error.code
  }
  if (typeof parsed.message === "string" && parsed.message.trim()) {
    return parsed.message
  }
  return "upstream websocket error"
}

/** Infer an HTTP-like status so the shared failover classifier can act. */
export function extractWsErrorStatus(parsed: Record<string, unknown>): number {
  if (typeof parsed.status === "number" && parsed.status >= 400) {
    return parsed.status
  }
  const error = readWsErrorPayload(parsed)
  if (!error) return 400
  if (typeof error.status === "number" && error.status >= 400) {
    return error.status
  }
  const marker = `${stringValue(error.type)} ${stringValue(error.code)}`
  if (/auth|unauthori[sz]ed|invalid_api_key|token_expired/i.test(marker)) {
    return 401
  }
  if (/usage_limit|quota|accountquotaexceeded/i.test(marker)) return 429
  if (/rate.?limit/i.test(marker)) return 429
  if (/server|internal|unavailable/i.test(marker)) return 500
  return 400
}

function readWsErrorPayload(
  parsed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (parsed.error && typeof parsed.error === "object") {
    return parsed.error as Record<string, unknown>
  }
  const response = parsed.response
  if (!response || typeof response !== "object") return undefined
  const error = (response as { error?: unknown }).error
  return error && typeof error === "object" ?
      (error as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * True when an upstream WS error frame means the server-side conversation
 * chain is missing for this turn: an orphan tool-call output (the client's
 * incremental input references a call the upstream never saw — e.g. after an
 * account switch or socket redial) or an unresolvable previous_response_id.
 * These are recoverable by replaying the full conversation (server-side
 * replay from the transcript cache) or by asking the client to resend it.
 */
export function isChainedTurnUpstreamError(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes("no tool call found for custom tool call output")
    || message.includes("no tool call found for function call output")
    || message.includes("previous_response_not_found")
    || (message.includes("previous response with id")
      && message.includes("not found"))
    || (message.includes("previous_response_id")
      && message.includes("not found"))
    || message.includes("no response found for previous_response_id")
    // ChatGPT 后端在 previous_response_id 无法解析时也可能返回
    // "Invalid `previous_response_id`."（不带 "not found"），和
    // "Previous response with id '...' not found." 是同一种 chain 断裂，
    // 需要同样的 transcript replay 恢复。
    || message.includes("invalid `previous_response_id`")
  )
}
