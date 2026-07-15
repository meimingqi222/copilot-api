import { createXaiResponsesOnce } from "~/services/xai/create-responses-once"

import type { AdapterResponsesResult, ProtocolAdapter } from "./types"

import { createChatViaResponses } from "./chat-via-responses"
import { requireTargetAccount } from "./shared"

export const xaiNativeAdapter: ProtocolAdapter = {
  protocol: "xai-native",

  async createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
    return createChatViaResponses({
      target,
      connection,
      credential,
      payload,
      signal,
      ctx,
      responsesExecutor: async ({
        target: tgt,
        payload: responsesPayload,
        signal: sig,
        ctx: context,
      }) => {
        const account = requireTargetAccount(tgt, "xai-native")
        const response = await createXaiResponsesOnce(
          account,
          responsesPayload,
          sig,
          context,
        )
        return { credentialId: account.id, response } as AdapterResponsesResult
      },
    })
  },

  async createResponses({ target, payload, signal, ctx }) {
    const account = requireTargetAccount(target, "xai-native")
    const response = await createXaiResponsesOnce(account, payload, signal, ctx)
    return { credentialId: account.id, response } as AdapterResponsesResult
  },
}
