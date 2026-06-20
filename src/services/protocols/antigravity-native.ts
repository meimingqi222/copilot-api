import type { Account } from "~/lib/accounts"

import { createAntigravityChatCompletionsOnce } from "~/services/antigravity/create-chat-completions-once"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("antigravity-native adapter: target.account is required")
  }
  return account
}

export const antigravityNativeAdapter: ProtocolAdapter = {
  protocol: "antigravity-native",

  // eslint-disable-next-line max-params
  async createChatCompletions(
    target,
    _connection,
    _credential,
    payload,
    signal,
    _ctx,
  ) {
    const account = extractAccount(target)
    const response = await createAntigravityChatCompletionsOnce(
      account,
      payload,
      signal,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
