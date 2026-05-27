/**
 * Windsurf Native Protocol Adapter。
 *
 * 把 legacy Windsurf Account 路径封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"

import type { ProtocolAdapter } from "./types"

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

    const result = await createWindsurfChatCompletionsOnce(
      account,
      payload,
      signal,
    )

    if (isChatCompletionResponse(result)) {
      return { credentialId: account.id, response: result }
    }

    return { credentialId: account.id, response: result }
  },
}

function isChatCompletionResponse(
  response: AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}
