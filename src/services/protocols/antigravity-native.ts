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

  async createChatCompletions({ target, payload, signal, ctx }) {
    const account = extractAccount(target)
    const response = await createAntigravityChatCompletionsOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
