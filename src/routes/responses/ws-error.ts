/**
 * WS error serialization.
 *
 * Extracted from `ws-handler.ts` to keep that file within the size budget. The
 * error-frame shape is the contract Codex reads: `status` must be present at
 * the top level or the client ignores the frame until idle timeout.
 */

import { HTTPError } from "~/lib/error"
import {
  ClientAbortError,
  getKnownRouteErrorDetails,
} from "~/lib/request-lifecycle"
import { retryableUsageLimit } from "~/lib/usage-limit"
import { isAbortError } from "~/lib/utils"

import type { WebSocketSendTarget } from "./ws-pump"

import { createResponsesErrorPayload } from "./handler"
import { sendText } from "./ws-pump"

export async function handleResponseError(
  ws: WebSocketSendTarget,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (isAbortError(error) && signal.aborted) {
    return
  }

  if (error instanceof ClientAbortError) {
    return
  }

  const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
  if (knownError) {
    await sendJson(
      ws,
      {
        type: "error",
        status: knownError.status,
        ...(knownError.retryAfterSeconds > 0 ?
          { headers: { "Retry-After": String(knownError.retryAfterSeconds) } }
        : {}),
        error: {
          message: knownError.message,
          type: knownError.type,
          code: knownError.type,
          ...(knownError.retryAfterSeconds > 0 ?
            { retry_after: knownError.retryAfterSeconds }
          : {}),
        },
      },
      signal,
    )
    return
  }

  // Frame body: `error.type` must not be `usage_limit_reached` — Codex reads
  // that as terminal, and the frame's `headers` are its only retry advice.
  if (error instanceof HTTPError) {
    const retryable = retryableUsageLimit({
      status: error.response.status,
      body: error.responseBody,
      retryAfterHeader: error.response.headers.get("retry-after"),
    })
    if (retryable) {
      await sendJson(
        ws,
        {
          type: "error",
          status: retryable.status,
          headers: {
            "Retry-After": String(Math.ceil(retryable.retryAfterMs / 1000)),
          },
          error: {
            message: retryable.message,
            type: "rate_limit_exceeded",
            code: "rate_limit_exceeded",
          },
        },
        signal,
      )
      return
    }
  }

  const payload = createResponsesErrorPayload(error)
  // Codex deserializes error.code as Option<String>; a numeric SSE code
  // makes it discard the entire WS error frame and wait for another event.
  if (typeof payload.error.code === "number")
    payload.error.code = String(payload.error.code)
  const retryAfter =
    error instanceof HTTPError ?
      error.response.headers.get("Retry-After")
    : null
  // Codex reads retry deadlines from frame headers, not error.retry_after or retryable.
  await sendJson(
    ws,
    {
      ...payload,
      ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}),
    },
    signal,
  )
}

export async function sendError(
  ws: WebSocketSendTarget,
  message: string,
  code?: string,
): Promise<void> {
  let status = 400
  if (code === "busy") status = 409
  if (code === "request_too_large") status = 413
  await sendJson(ws, {
    type: "error",
    status,
    error: {
      message,
      type: "invalid_request_error",
      code: code ?? "invalid_request",
    },
  })
}

export async function sendJson(
  ws: WebSocketSendTarget,
  payload: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  return sendText(ws, JSON.stringify(payload), signal)
}
