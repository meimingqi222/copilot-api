import { createAntigravityChatCompletionsOnce } from "~/services/antigravity/create-chat-completions-once"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

import { requireTargetAccount } from "./shared"

export const antigravityNativeAdapter: ProtocolAdapter = {
  protocol: "antigravity-native",

  async createChatCompletions({ target, payload, signal, ctx }) {
    const account = requireTargetAccount(target, "antigravity-native")
    const response = await createAntigravityChatCompletionsOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
