/**
 * Shared WebSocket Responses failure taxonomy.
 *
 * A `response.create` turn on an upstream Responses WebSocket can fail for very
 * different reasons, and the *retry ownership* differs per reason:
 *
 *   - `abort`      — client/aborted; never retry, just stop.
 *   - `request`    — genuine bad request (invalid body, malformed input);
 *                    never retry (would only poll every account for nothing).
 *   - `credential` — the current account/credential is the problem (quota
 *                    exhausted, auth, rate-limit, upstream 5xx); the handler
 *                    switches to the next same-protocol account.
 *   - `connection` — the current *socket* is the problem (handshake failure,
 *                    first-event timeout, idle timeout, socket drop, connection
 *                    limit reached, previous_response_not_found); stay on the
 *                    same account and redial / fall back to HTTP.
 *
 * This is the single source of truth folding the older
 * `isUpstreamWsTransportError` heuristic and the `usage_limit_reached → 429`
 * promotion into one classifier. A parsed upstream WS error frame is turned
 * into an `HTTPError` (with the raw frame as body) by the low-level generator
 * in `upstream-ws.ts` *before* it is yielded, so this classifier mostly sees
 * `HTTPError`; it also accepts raw transport/abort errors.
 */

import { HTTPError } from "~/lib/error"
import { classifyUpstreamError } from "~/lib/provider-connections"
import { isAbortLikeError } from "~/services/responses/upstream-ws"

export type WsFailureScope = "abort" | "request" | "credential" | "connection"

export type WsFailureKind =
  | "abort"
  | "invalid_request"
  | "quota"
  | "auth"
  | "rate"
  | "server"
  | "connection_limit"
  | "previous_response_not_found"
  | "transport"

export interface ClassifiedWsFailure {
  scope: WsFailureScope
  kind: WsFailureKind
  retryAfterMs?: number
  status?: number
}

/**
 * Connection-scoped error markers. These frequently arrive as WS error frames
 * carrying a 4xx status, but they are NOT credential problems: the current
 * upstream socket is unusable and must be redialed on the *same* account.
 */
const CONNECTION_LIMIT_RE = /websocket_connection_limit_reached/i
const PREVIOUS_RESPONSE_NOT_FOUND_RE =
  /previous_response_not_found|previous response with id|invalid `previous_response_id`/i

interface WsStreamErrorPayload {
  type?: unknown
  code?: unknown
  resets_at?: unknown
  resets_in_seconds?: unknown
}

/**
 * Detects a quota-exhaustion WS error frame whose error payload lives under
 * `response.error` (a `response.failed` frame) or the top-level `error` (an
 * `error` frame). Mirrors `detectResponsesStreamError`'s payload extraction so
 * a `response.failed(usage_limit_reached)` turn is recognized as quota rather
 * than a plain 400 bad request. Returns the retry hint (ms) when present.
 */
function detectStreamQuota(body: string): { retryAfterMs?: number } | null {
  let parsed: {
    type?: unknown
    error?: WsStreamErrorPayload
    response?: { error?: WsStreamErrorPayload }
  }
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    return null
  }
  const payload = parsed.response?.error ?? parsed.error
  const type = payload?.type ?? parsed.type
  const code = payload?.code
  if (type !== "usage_limit_reached" && code !== "AccountQuotaExceeded") {
    return null
  }

  const resetsAt = payload?.resets_at
  if (typeof resetsAt === "number" && resetsAt > 0) {
    const diff = resetsAt * 1000 - Date.now()
    if (diff > 0) return { retryAfterMs: diff }
  }
  const resetsInSeconds = payload?.resets_in_seconds
  if (typeof resetsInSeconds === "number" && resetsInSeconds > 0) {
    return { retryAfterMs: resetsInSeconds * 1000 }
  }
  return {}
}

/**
 * Classify a WS `response.create` failure into a retry scope. Recognizes the
 * failure by `error.code`/`type`/body markers, not just HTTP status, so a
 * quota frame with no status still maps to `credential`.
 */
export function classifyWsFailure(error: unknown): ClassifiedWsFailure {
  if (isAbortLikeError(error)) {
    return { scope: "abort", kind: "abort" }
  }

  if (error instanceof HTTPError) {
    const status = error.response.status
    const body = error.responseBody || error.message || ""

    if (CONNECTION_LIMIT_RE.test(body)) {
      return { scope: "connection", kind: "connection_limit", status }
    }
    if (PREVIOUS_RESPONSE_NOT_FOUND_RE.test(body)) {
      return {
        scope: "connection",
        kind: "previous_response_not_found",
        status,
      }
    }

    // A `response.failed(usage_limit_reached)` frame nests its error under
    // `response.error`, which `classifyUpstreamError` (top-level `error` only)
    // would misread as a plain 400 bad request. Detect quota first so the
    // handler fails over instead of surfacing it.
    const quota = detectStreamQuota(body)
    if (quota) {
      return {
        scope: "credential",
        kind: "quota",
        retryAfterMs: quota.retryAfterMs,
        status,
      }
    }

    const classified = classifyUpstreamError({
      status,
      retryAfterHeader: error.response.headers.get("retry-after"),
      body,
    })
    switch (classified.kind) {
      case "quota_exhausted": {
        return {
          scope: "credential",
          kind: "quota",
          retryAfterMs: classified.retryAfterMs,
          status,
        }
      }
      case "auth_error": {
        return { scope: "credential", kind: "auth", status }
      }
      case "rate_limited": {
        return {
          scope: "credential",
          kind: "rate",
          retryAfterMs: classified.retryAfterMs,
          status,
        }
      }
      case "server_error": {
        return {
          scope: "credential",
          kind: "server",
          retryAfterMs: classified.retryAfterMs,
          status,
        }
      }
      case "client_error": {
        // Genuine bad request — never poll all accounts.
        return { scope: "request", kind: "invalid_request", status }
      }
      default: {
        // network_error / unknown: treat as a transport/connection problem.
        return { scope: "connection", kind: "transport", status }
      }
    }
  }

  // Non-HTTPError: handshake failure, socket drop/close, idle timeout, etc.
  return { scope: "connection", kind: "transport" }
}
