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
