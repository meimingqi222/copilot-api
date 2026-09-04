/**
 * Claude Native Protocol Adapter。
 *
 * Phase 2d:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createClaudeMessagesOnce } from "~/services/claude/create-messages-once"

import type { AdapterMessagesResult, ProtocolAdapter } from "./types"

export const claudeNativeAdapter: ProtocolAdapter = {
  protocol: "claude-native",

  async createMessages({ connection, credential, payload, signal, ctx }) {
    const response = await createClaudeMessagesOnce(
      { connection, credential },
      payload,
      signal,
      ctx,
    )
    return { credentialId: credential.id, response } as AdapterMessagesResult
  },
}
