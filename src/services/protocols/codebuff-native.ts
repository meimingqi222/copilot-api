/**
 * Codebuff Native Protocol Adapter。
 *
 * Phase 2b:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createCodebuffChatCompletionsOnce } from "~/services/codebuff/create-chat-completions"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

export const codebuffNativeAdapter: ProtocolAdapter = {
  protocol: "codebuff-native",

  async createChatCompletions({ connection, credential, payload, signal }) {
    const response = await createCodebuffChatCompletionsOnce(
      { connection, credential },
      payload,
      signal,
    )
    return { credentialId: credential.id, response } as AdapterChatResult
  },
}
