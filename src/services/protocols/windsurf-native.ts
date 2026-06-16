/**
 * Windsurf Native Protocol Adapter。
 *
 * 把 legacy Windsurf Account 路径封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import type { Account } from "~/lib/accounts"

import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("windsurf-native adapter: target.account is required")
  }
  return account
}

export const windsurfNativeAdapter: ProtocolAdapter = {
  protocol: "windsurf-native",

  // eslint-disable-next-line max-params
  async createChatCompletions(
    target,
    _connection,
    _credential,
    payload,
    signal,
    _ctx,
  ) {
    const account = extractAccount(target)
    const response = await createWindsurfChatCompletionsOnce(
      account,
      payload,
      signal,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
