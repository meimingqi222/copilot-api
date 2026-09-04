/**
 * Codex Native Protocol Adapter。
 *
 * Phase 2d:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"

import type { AdapterResponsesResult, ProtocolAdapter } from "./types"

import { createChatViaResponses } from "./chat-via-responses"

export const codexNativeAdapter: ProtocolAdapter = {
  protocol: "codex-native",

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
        const response = await createCodexResponsesOnce(
          { connection: conn, credential },
          responsesPayload,
          sig,
          context,
        )
        return {
          credentialId: credential.id,
          response,
        } as AdapterResponsesResult
      },
    })
  },

  async createResponses({ connection, credential, payload, signal, ctx }) {
    const response = await createCodexResponsesOnce(
      { connection, credential },
      payload,
      signal,
      ctx,
    )
    return { credentialId: credential.id, response } as AdapterResponsesResult
  },
}
