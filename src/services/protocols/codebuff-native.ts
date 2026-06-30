/**
 * Codebuff Native Protocol Adapter。
 *
 * 把 legacy Codebuff Account 路径封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import type { Account } from "~/lib/accounts"

import { createCodebuffChatCompletionsOnce } from "~/services/codebuff/create-chat-completions"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("codebuff-native adapter: target.account is required")
  }
  return account
}

export const codebuffNativeAdapter: ProtocolAdapter = {
  protocol: "codebuff-native",

  async createChatCompletions({ target, payload, signal }) {
    const account = extractAccount(target)
    const response = await createCodebuffChatCompletionsOnce(
      account,
      payload,
      signal,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
