import type { Account } from "~/lib/accounts"

import { createClaudeMessagesOnce } from "~/services/claude/create-messages-once"

import type { AdapterMessagesResult, ProtocolAdapter } from "./types"

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("claude-native adapter: target.account is required")
  }
  return account
}

export const claudeNativeAdapter: ProtocolAdapter = {
  protocol: "claude-native",

  // eslint-disable-next-line max-params
  async createMessages(target, _connection, _credential, payload, signal, ctx) {
    const account = extractAccount(target)
    const response = await createClaudeMessagesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterMessagesResult
  },
}
