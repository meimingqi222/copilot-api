/**
 * WS error serialization.
 *
 * Extracted from `ws-handler.ts` to keep that file within the size budget. The
 * error-frame shape is the contract Codex reads: `status` must be present at
 * the top level or the client ignores the frame until idle timeout.
 */

import {
  ClientAbortError,
  getKnownRouteErrorDetails,
} from "~/lib/request-lifecycle"
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

  await sendJson(ws, createResponsesErrorPayload(error), signal)
}

export async function sendError(
  ws: WebSocketSendTarget,
  message: string,
  code?: string,
): Promise<void> {
  await sendJson(ws, {
    type: "error",
    error: {
      message,
      type: "error",
      ...(code ? { code } : {}),
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
