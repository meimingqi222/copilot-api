import { randomUUID } from "node:crypto"

import type { Account } from "~/lib/accounts"

import { getOAuthAccountId, isOAuthAccount } from "~/lib/accounts"

const CODEX_USER_AGENT =
  "codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)"

export function buildCodexHeaders(
  account: Account,
  accessToken: string,
  stream?: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": CODEX_USER_AGENT,
    Originator: "codex-tui",
    Connection: "Keep-Alive",
    Session_id: randomUUID(),
    "X-Client-Request-Id": randomUUID(),
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
