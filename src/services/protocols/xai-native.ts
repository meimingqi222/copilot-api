import type { Account } from "~/lib/accounts"

import { createXaiResponsesOnce } from "~/services/xai/create-responses-once"

import type { AdapterResponsesResult, ProtocolAdapter } from "./types"

import { createChatViaResponses } from "./chat-via-responses"

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("xai-native adapter: target.account is required")
  }
  return account
}

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
        const account = extractAccount(tgt)
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
    const account = extractAccount(target)
    const response = await createXaiResponsesOnce(account, payload, signal, ctx)
    return { credentialId: account.id, response } as AdapterResponsesResult
  },
}
