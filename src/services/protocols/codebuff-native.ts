/**
 * Codebuff Native Protocol Adapter。
 *
 * 把 legacy Codebuff Account 路径封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import { connectionToAccount } from "~/lib/provider-connections"
import { createCodebuffChatCompletionsOnce } from "~/services/codebuff/create-chat-completions"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

export const codebuffNativeAdapter: ProtocolAdapter = {
  protocol: "codebuff-native",

  async createChatCompletions({ connection, payload, signal }) {
    const account = connectionToAccount(connection)
    const response = await createCodebuffChatCompletionsOnce(
      account,
      payload,
      signal,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
