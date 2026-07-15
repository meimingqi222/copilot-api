/**
 * Windsurf Native Protocol Adapter。
 *
 * 把 legacy Windsurf Account 路径封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import { connectionToAccount } from "~/lib/provider-connections"
import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

export const windsurfNativeAdapter: ProtocolAdapter = {
  protocol: "windsurf-native",

  async createChatCompletions({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    const response = await createWindsurfChatCompletionsOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
