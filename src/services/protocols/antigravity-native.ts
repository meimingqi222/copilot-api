/**
 * Antigravity Native Protocol Adapter。
 *
 * Phase 2d:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createAntigravityChatCompletionsOnce } from "~/services/antigravity/create-chat-completions-once"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

export const antigravityNativeAdapter: ProtocolAdapter = {
  protocol: "antigravity-native",

  async createChatCompletions({
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
    const response = await createAntigravityChatCompletionsOnce(
      { connection, credential },
      payload,
      signal,
      ctx,
    )
    return { credentialId: credential.id, response } as AdapterChatResult
  },
}
