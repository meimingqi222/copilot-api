import { createClaudeMessagesOnce } from "~/services/claude/create-messages-once"

import type { AdapterMessagesResult, ProtocolAdapter } from "./types"

import { requireTargetAccount } from "./shared"

export const claudeNativeAdapter: ProtocolAdapter = {
  protocol: "claude-native",

  async createMessages({ target, payload, signal, ctx }) {
    const account = requireTargetAccount(target, "claude-native")
    const response = await createClaudeMessagesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterMessagesResult
  },
}
