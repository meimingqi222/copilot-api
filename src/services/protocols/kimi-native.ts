import type { Account } from "~/lib/accounts"

import { createKimiChatCompletionsOnce } from "~/services/kimi/create-chat-completions-once"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("kimi-native adapter: target.account is required")
  }
  return account
}

export const kimiNativeAdapter: ProtocolAdapter = {
  protocol: "kimi-native",

  async createChatCompletions({ target, payload, signal }) {
    const account = extractAccount(target)
    const response = await createKimiChatCompletionsOnce(
      account,
      payload,
      signal,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
