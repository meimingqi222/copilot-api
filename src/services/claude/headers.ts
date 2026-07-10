import { randomUUID } from "node:crypto"

import { getStableSessionId } from "~/lib/cache/session-id-cache"

const CLAUDE_BETA_HEADERS =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28"

export interface ClaudeHeaderOptions {
  /**
   * Stable Claude Code session identifier. The official Claude Code CLI sends
   * `X-Claude-Code-Session-Id` on every request within a session. Anthropic's
   * backend uses this to group requests and reuse cached prompt prefixes.
   * When omitted, a random UUID is generated (which breaks prefix caching).
   *
   * Forwarded from the incoming request's `X-Claude-Code-Session-Id` header.
   */
  sessionId?: string
  /**
   * Per-request UUID sent as `x-client-request-id`. Always fresh per request,
   * matching the official Claude Code CLI behavior.
   */
  requestId?: string
}

export async function buildClaudeOAuthHeaders(options: {
  accessToken: string
  stream?: boolean
  anthropicBeta?: string
  anthropicVersion?: string
  sessionId?: string
  /** Credential key for stable session ID generation (account ID or API key). */
  credentialKey?: string
}): Promise<Record<string, string>> {
  const beta = options.anthropicBeta?.trim() || CLAUDE_BETA_HEADERS
  const mergedBeta =
    beta.includes("oauth-2025-04-20") ? beta : `${beta},oauth-2025-04-20`

  // L1 Claude: X-Claude-Code-Session-Id (CPA CachedSessionID).
  // Priority: client header → per-credential stable UUID → random last resort.
  let sessionId = options.sessionId?.trim()
  if (!sessionId && options.credentialKey) {
    sessionId = await getStableSessionId(options.credentialKey)
  }
  if (!sessionId) {
    sessionId = randomUUID()
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
    "Content-Type": "application/json",
    "anthropic-version": options.anthropicVersion ?? "2023-06-01",
    "anthropic-beta": mergedBeta,
    "X-App": "cli",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Timeout": "600",
    // Forward the stable session ID so Anthropic's backend can reuse cached
    // prompt prefixes across turns. A random UUID per request destroys cache.
    "X-Claude-Code-Session-Id": sessionId,
    "x-client-request-id": randomUUID(),
    Connection: "keep-alive",
  }

  if (options.stream) {
    headers.Accept = "text/event-stream"
    headers["Accept-Encoding"] = "identity"
  } else {
    headers.Accept = "application/json"
    headers["Accept-Encoding"] = "gzip, deflate, br"
  }

  return headers
}
