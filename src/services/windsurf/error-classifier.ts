/**
 * Windsurf upstream error classification.
 *
 * Windsurf returns errors as in-stream JSON frames (after a 200 OK) shaped as:
 *   {"error":{"code":"Permission denied","message":"...Reached message rate limit...Resets in: 3h0m0s..."}}
 * or as HTTP error responses with the same body.
 *
 * Unlike the Devin CLI (which receives structured `cognition.ai/retryAfterSeconds`
 * metadata over ACP), copilot-api only gets the natural-language `message`, so we
 * parse "Resets in: XhYmZs" ourselves to recover the real cooldown window.
 *
 * The `WindsurfUpstreamError` class carries the parsed `kind` + `retryAfterMs`
 * so `failover.ts:markCooldown` can apply an accurate cooldown instead of the
 * default 60s exponential backoff (which causes immediate retry → re-trigger).
 */

import { parseWindsurfFrameError } from "./response-parsers"

export type WindsurfErrorKind =
  | "rate_limited" // "Reached message rate limit" — per-model message quota (recoverable)
  | "quota_exhausted" // "Quota exhausted" / quota/balance keywords
  | "auth_error" // "Unauthenticated" / auth-related "Permission denied"
  | "server_error"
  | "client_error"
  | "unknown"

export interface ClassifiedWindsurfError {
  kind: WindsurfErrorKind
  retryAfterMs?: number
  message: string
  code?: string
}

/**
 * Parse a "Resets in: XhYmZs" duration from a Windsurf error message.
 * Returns milliseconds, or undefined if no parseable duration is found.
 *
 * Examples: "3h0m0s" → 10800000, "1h30m" → 5400000, "45m0s" → 2700000, "90s" → 90000
 */
export function parseResetsInDuration(message: string): number | undefined {
  const m = message.match(/Resets in:\s*(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i)
  if (!m) return undefined
  const h = m[1] ? Number.parseInt(m[1], 10) : 0
  const min = m[2] ? Number.parseInt(m[2], 10) : 0
  const sec = m[3] ? Number.parseInt(m[3], 10) : 0
  const totalMs = (h * 3_600 + min * 60 + sec) * 1_000
  return totalMs > 0 ? totalMs : undefined
}

/**
 * Classify a raw Windsurf error frame (Uint8Array) into a structured error.
 * Returns undefined if the frame is not a recognized Windsurf error JSON.
 */
export function classifyWindsurfFrameError(
  frame: Uint8Array,
): ClassifiedWindsurfError | undefined {
  const combined = parseWindsurfFrameError(frame)
  if (!combined) return undefined

  // Re-parse the raw JSON to access code + message separately
  let code: string | undefined
  let message = combined
  const text = Buffer.from(frame).toString("utf8").trim()
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: string; message?: string }
      }
      code = parsed.error?.code
      message = parsed.error?.message ?? combined
    } catch {
      // keep combined string as message
    }
  }

  return classifyWindsurfErrorText(code, message)
}

/**
 * Classify from already-parsed code + message strings (also used for HTTP
 * error response bodies that share the same {error:{code,message}} shape).
 */
export function classifyWindsurfErrorText(
  code: string | undefined,
  message: string,
): ClassifiedWindsurfError {
  const lowerMsg = message.toLowerCase()
  const lowerCode = (code ?? "").toLowerCase()

  // "Permission denied" with "message rate limit" / "Resets in" → per-model
  // message quota (the 3h-reset error the user encountered).
  if (/message rate limit/.test(lowerMsg) || /resets in:/.test(lowerMsg)) {
    return {
      kind: "rate_limited",
      retryAfterMs: parseResetsInDuration(message),
      message,
      code,
    }
  }

  if (/quota|exhausted|balance|insufficient/.test(lowerMsg)) {
    return {
      kind: "quota_exhausted",
      retryAfterMs: parseResetsInDuration(message),
      message,
      code,
    }
  }

  if (/unauthenticated|invalid api key|auth/i.test(lowerCode + lowerMsg)) {
    return { kind: "auth_error", message, code }
  }

  if (/internal|server error|unavailable/.test(lowerMsg)) {
    return { kind: "server_error", message, code }
  }

  return { kind: "unknown", message, code }
}

/**
 * Custom error class carrying parsed Windsurf error metadata.
 *
 * Thrown from the streaming loop (create-chat-completions.ts) and from the
 * HTTP-level error path. Recognized by failover.ts:markCooldown to apply
 * an accurate cooldown duration derived from "Resets in: XhYmZs".
 */
export class WindsurfUpstreamError extends Error {
  kind: WindsurfErrorKind
  retryAfterMs?: number
  code?: string
  rawFrame: Uint8Array

  constructor(classified: ClassifiedWindsurfError, rawFrame: Uint8Array) {
    const codePart = classified.code ? `${classified.code}: ` : ""
    super(`Windsurf upstream error: ${codePart}${classified.message}`)
    this.name = "WindsurfUpstreamError"
    this.kind = classified.kind
    this.retryAfterMs = classified.retryAfterMs
    this.code = classified.code
    this.rawFrame = rawFrame
  }
}
