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
   * and reuse cached prompt prefixes.
   *
   * Resolved from the incoming request's `prompt_cache_key` body field or
   * `session_id` / `session-id` header. When unknown the header is omitted
   * entirely — the official client (`build_session_headers` in
   * codex-api/src/requests/headers.rs) only sends `Option` ids and never
   * invents a random one per request (a fresh UUID per request would destroy
   * cache affinity and pollute backend session tracking).
   */
  sessionId?: string
  /**
   * Stable thread identifier, sent as `thread-id`.
   *
   * Resolved from the incoming request's `thread_id` / `thread-id` header
   * (falling back to `x-client-request-id` for proxy-fronted clients). When
   * unknown the header is omitted. `x-client-request-id` is intentionally
   * NOT sent on HTTP — the official client only sends it on the WebSocket
   * handshake with the thread id as value (see applyCodexWebsocketHeaders).
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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": CODEX_USER_AGENT,
    Originator: "codex-tui",
    Connection: "Keep-Alive",
  }

  // The official client sends exactly one session header spelling,
  // `session-id` (hyphen) — never the `session_id` underscore variant and
  // never a per-request random id. Omit the header when unknown.
  const sessionId = options?.sessionId?.trim()
  if (sessionId) {
    headers["session-id"] = sessionId
  }

  // Likewise `thread-id` only; `x-client-request-id` is WebSocket-only
  // upstream and is added by applyCodexWebsocketHeaders instead.
  const threadId = options?.threadId?.trim()
  if (threadId) {
    headers["thread-id"] = threadId
  }

  if (options?.accountId) {
    headers["Chatgpt-Account-Id"] = options.accountId
  }

  headers.Accept = stream ? "text/event-stream" : "application/json"

  return headers
}
