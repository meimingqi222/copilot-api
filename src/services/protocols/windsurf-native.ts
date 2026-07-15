/**
 * Windsurf Native Protocol Adapter。
 *
 * 把 legacy Windsurf Account 路径封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

import { requireTargetAccount } from "./shared"

export const windsurfNativeAdapter: ProtocolAdapter = {
  protocol: "windsurf-native",

  async createChatCompletions({ target, payload, signal, ctx }) {
    const account = requireTargetAccount(target, "windsurf-native")
    const response = await createWindsurfChatCompletionsOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },
}
