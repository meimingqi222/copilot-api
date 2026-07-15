/**
 * Codebuff Native Protocol Adapter。
 *
 * 把 legacy Codebuff Account 路径封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import { createCodebuffChatCompletionsOnce } from "~/services/codebuff/create-chat-completions"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

import { requireTargetAccount } from "./shared"

export const codebuffNativeAdapter: ProtocolAdapter = {
  protocol: "codebuff-native",

  async createChatCompletions({ target, payload, signal }) {
    const account = requireTargetAccount(target, "codebuff-native")
    const response = await createCodebuffChatCompletionsOnce(
      account,
      payload,
      signal,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
