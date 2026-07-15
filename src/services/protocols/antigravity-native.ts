import { connectionToAccount } from "~/lib/provider-connections"
import { createAntigravityChatCompletionsOnce } from "~/services/antigravity/create-chat-completions-once"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

export const antigravityNativeAdapter: ProtocolAdapter = {
  protocol: "antigravity-native",

  async createChatCompletions({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    const response = await createAntigravityChatCompletionsOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
