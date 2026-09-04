import { randomUUID } from "node:crypto"

// Codex CLI client version advertised to the ChatGPT backend. Upstream filters
// the /models catalog by this value, so it must stay aligned with the current
// Codex CLI release to receive new models (e.g. gpt-6-astra requires >= 0.153.0).
// Keep in sync with CPA cmd/fetch_codex_models defaultClientVersion.
export const CODEX_CLIENT_VERSION = "0.153.3"

const CODEX_USER_AGENT = `codex-tui/${CODEX_CLIENT_VERSION} (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; ${CODEX_CLIENT_VERSION})`

export interface CodexHeaderOptions {
  /**
   * Stable session identifier reused across all requests in the same
   * conversation session. The ChatGPT backend uses this to group requests
   * and reuse cached prompt prefixes. When omitted, a random UUID is
   * generated (which breaks prefix caching for subsequent turns).
   *
   * Forwarded from the incoming request's `session_id` / `session-id` header
   * sent by the codex CLI client.
   */
  sessionId?: string
  /**
   * Stable thread identifier. The official codex CLI sends this as
   * `x-client-request-id`. When omitted, a random UUID is generated.
   */
  threadId?: string
  /**
   * OAuth account id (credential.context.oauthAccountId), sent as
   * `Chatgpt-Account-Id` when present.
   */
  accountId?: string
}

export function buildCodexHeaders(
  accessToken: string,
  stream?: boolean,
  options?: CodexHeaderOptions,
): Record<string, string> {
  const sessionId = options?.sessionId?.trim() || randomUUID()
  const threadId = options?.threadId?.trim() || randomUUID()

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": CODEX_USER_AGENT,
    Originator: "codex-tui",
    Connection: "Keep-Alive",
    // Send both underscore and hyphenated spellings to match the official
    // codex CLI behavior (PR openai/codex#21757). The ChatGPT backend uses
    // session_id to associate requests within a session and reuse cached
    // prompt prefixes — a new UUID per request destroys cache hit rate.
    session_id: sessionId,
    "session-id": sessionId,
    "x-client-request-id": threadId,
  }

  if (options?.accountId) {
    headers["Chatgpt-Account-Id"] = options.accountId
  }

  headers.Accept = stream ? "text/event-stream" : "application/json"

  return headers
}
