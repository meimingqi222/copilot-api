import { connectionToAccount } from "~/lib/provider-connections"
import { createXaiResponsesOnce } from "~/services/xai/create-responses-once"

import type { AdapterResponsesResult, ProtocolAdapter } from "./types"

import { createChatViaResponses } from "./chat-via-responses"

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
        connection: conn,
        payload: responsesPayload,
        signal: sig,
        ctx: context,
      }) => {
        const account = connectionToAccount(conn)
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

  async createResponses({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    const response = await createXaiResponsesOnce(account, payload, signal, ctx)
    return { credentialId: account.id, response } as AdapterResponsesResult
  },
}
