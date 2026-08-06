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
