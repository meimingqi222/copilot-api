import { resolveRetryableCode } from "~/lib/error-builder"

import type { AnthropicStreamEventData } from "./types"

/** Shape any error as an Anthropic `error` stream event (error surgery, not a
 * pair translator — survives the legacy translation removal). */
export function translateErrorToAnthropicErrorEvent(
  error?: unknown,
): AnthropicStreamEventData {
  // A numeric, status-like code lets downstream one-shot clients (Zcode,
  // opencode, Anthropic SDK) classify the failure. `>=500` (and 429) is
  // treated as a retryable upstream error; without it, providers that only
  // pass a 200 + inline error event (CodeBuddy, etc.) surface as a
  // non-retryable generic failure.
  const code = resolveRetryableCode(error)
  return {
    type: "error",
    error: {
      type: code === 429 ? "rate_limit_error" : "api_error",
      message:
        error instanceof Error ?
          error.message
        : "An unexpected error occurred during streaming.",
      code,
      status: code,
    },
  }
}

// `extractSignatureAlias` moved to ~/lib/thinking — the request side needs the
// same chain, so it can no longer live under the Anthropic protocol folder.
