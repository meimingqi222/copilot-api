import { randomUUID } from "node:crypto"

import type { Account } from "~/lib/accounts"

import { getOAuthAccountId, isOAuthAccount } from "~/lib/accounts"

const CODEX_USER_AGENT =
  "codex-tui/0.144.1 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.144.1)"

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
}

export function buildCodexHeaders(
  account: Account,
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

  if (isOAuthAccount(account)) {
    const accountId = getOAuthAccountId(account)
    if (accountId) {
      headers["Chatgpt-Account-Id"] = accountId
    }
  }

  headers.Accept = stream ? "text/event-stream" : "application/json"

  return headers
}
