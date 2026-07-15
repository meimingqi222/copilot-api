import { connectionToAccount } from "~/lib/provider-connections"
import { createClaudeMessagesOnce } from "~/services/claude/create-messages-once"

import type { AdapterMessagesResult, ProtocolAdapter } from "./types"

export const claudeNativeAdapter: ProtocolAdapter = {
  protocol: "claude-native",

  async createMessages({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    const response = await createClaudeMessagesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterMessagesResult
  },
}
