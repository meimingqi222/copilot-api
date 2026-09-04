/**
 * Kimi Native Protocol Adapter。
 *
 * Phase 2d:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createKimiChatCompletionsOnce } from "~/services/kimi/create-chat-completions-once"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

export const kimiNativeAdapter: ProtocolAdapter = {
  protocol: "kimi-native",

  async createChatCompletions({ connection, credential, payload, signal }) {
    const response = await createKimiChatCompletionsOnce(
      { connection, credential },
      payload,
      signal,
    )
    return { credentialId: credential.id, response } as AdapterChatResult
  },
}
