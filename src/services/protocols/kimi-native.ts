import { createKimiChatCompletionsOnce } from "~/services/kimi/create-chat-completions-once"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

import { requireTargetAccount } from "./shared"

export const kimiNativeAdapter: ProtocolAdapter = {
  protocol: "kimi-native",

  async createChatCompletions({ target, payload, signal }) {
    const account = requireTargetAccount(target, "kimi-native")
    const response = await createKimiChatCompletionsOnce(
      account,
      payload,
      signal,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
