import { HTTPError } from "~/lib/error"

/**
 * Extracts error message from HTTPError response body or generic error message.
 * Supports double-encoded JSON unwrapping.
 */
export function extractErrorMessage(
  error: unknown,
  defaultMessage = "Internal server error",
): string {
  if (error instanceof HTTPError) {
    let msg = error.responseBody || error.message
    try {
      const parsed = JSON.parse(error.responseBody) as {
        error?: { message?: string }
        message?: string
      }
      // `||`: an upstream that sends `{ error: { message: "" }, message: "..." }`
      // still has a usable message under the outer spelling.
      const raw = parsed.error?.message || parsed.message
      if (raw) {
        msg =
          raw.startsWith("{") ?
            ((JSON.parse(raw) as { error?: { message?: string } }).error
              ?.message ?? raw)
          : raw
      }
    } catch {
      // ignore
    }
    return msg
  }

  if (error instanceof Error) {
    return error.message
  }

  return defaultMessage
}

export function buildAnthropicContextWindowError(error: HTTPError): {
  type: string
  error: { type: string; message: string }
} {
  const defaultMessage =
    "Your input exceeds the context window of this model. Please adjust your input and try again."
  let message = defaultMessage
  try {
    const parsed = JSON.parse(error.responseBody) as {
      error?: { message?: string }
    }
    if (parsed.error?.message) {
      message = parsed.error.message
    }
    if (message.startsWith("{")) {
      const inner = JSON.parse(message) as { error?: { message?: string } }
      message = inner.error?.message || defaultMessage
    }
  } catch {
    // Keep default message
  }
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message,
    },
  }
}

export function buildAnthropicUpstreamError(error: HTTPError): {
  type: string
  error: { type: string; message: string }
} {
  const msg = extractErrorMessage(error)
  const prefix = `Upstream API error (${error.response.status}): `
  const message = msg.startsWith(prefix) ? msg : `${prefix}${msg}`
  return {
    type: "error",
    error: {
      type: "api_error",
      message,
    },
  }
}

/**
 * Resolve the numeric code to attach to a streamed error frame so that
 * downstream one-shot clients (ZCode, opencode, OpenAI SDKs) can classify the
 * failure as retryable.
 *
 * These clients key retryability off a numeric field read as an HTTP status:
 * - opencode reads `event.error.code` as a status → `>=500`/429 ⇒ retryable
 * - ZCode decodes `code`/`providerCode`/`error_code` and maps a status in
 *   400–599; `>=500` ⇒ `retryable: true`
 * - The Responses API client maps a top-level `status` into its retry budget
 *
 * Rules:
 * - Prefer the real upstream HTTP status when it exists (429/5xx are retryable;
 *   4xx stay non-retryable).
 * - When an upstream non-HTTP provider error surfaces (e.g. CodeBuddy's
 *   OpenAI-compatible wire error), there is no HTTP status to reuse, so fall
 *   back to 500 so the failure is treated as retryable. The upstream code (e.g.
 *   `11134`) is preserved in the message for diagnostics.
 * - `undefined` (no upstream status, non-HTTPError) → 500.
 */
export function resolveRetryableCode(error: unknown): number {
  if (error instanceof HTTPError) {
    const status = error.response.status
    if (status >= 400 && status <= 599) return status
  }
  return 500
}
