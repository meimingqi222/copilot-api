import { connectionToAccount } from "~/lib/provider-connections"
import { createKimiChatCompletionsOnce } from "~/services/kimi/create-chat-completions-once"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

export const kimiNativeAdapter: ProtocolAdapter = {
  protocol: "kimi-native",

  async createChatCompletions({ connection, payload, signal }) {
    const account = connectionToAccount(connection)
    const response = await createKimiChatCompletionsOnce(
      account,
      payload,
      signal,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
