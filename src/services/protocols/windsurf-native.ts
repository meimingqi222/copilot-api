/**
 * Windsurf Native Protocol Adapter。
 *
 * Phase 2b:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

export const windsurfNativeAdapter: ProtocolAdapter = {
  protocol: "windsurf-native",

  async createChatCompletions({
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
    const response = await createWindsurfChatCompletionsOnce(
      { connection, credential },
      payload,
      signal,
      ctx,
    )
    return { credentialId: credential.id, response } as AdapterChatResult
  },
}
