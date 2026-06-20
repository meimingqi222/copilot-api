import { randomUUID } from "node:crypto"

const CLAUDE_BETA_HEADERS =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28"

export function buildClaudeOAuthHeaders(options: {
  accessToken: string
  stream?: boolean
  anthropicBeta?: string
  anthropicVersion?: string
}): Record<string, string> {
  const beta = options.anthropicBeta?.trim() || CLAUDE_BETA_HEADERS
  const mergedBeta =
    beta.includes("oauth-2025-04-20") ? beta : `${beta},oauth-2025-04-20`

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
    "X-Claude-Code-Session-Id": randomUUID(),
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
