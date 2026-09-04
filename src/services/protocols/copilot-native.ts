/**
 * Copilot Native Protocol Adapter。
 *
 * Phase 2a:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import type {
  AdapterChatResult,
  AdapterEmbeddingsResult,
  AdapterMessagesResult,
  AdapterResponsesResult,
  ProtocolAdapter,
} from "~/services/protocols/types"

import { isChatCompletionResponse } from "~/lib/utils"
import { createCopilotChatCompletionsOnce } from "~/services/copilot/create-chat-completions-once"
import { createCopilotEmbeddingsOnce } from "~/services/copilot/create-embeddings-once"
import { createCopilotMessagesOnce } from "~/services/copilot/create-messages-once"
import { createCopilotResponsesOnce } from "~/services/copilot/create-responses-once"
import {
  supportsResponsesApiForConnection,
  translateChatCompletionToResponses,
  translateChatCompletionsStreamToResponses,
  translateResponsesToChatPayload,
} from "~/services/copilot/responses-api"
import { ensureCopilotToken } from "~/services/copilot/token-refresh"

export const copilotNativeAdapter: ProtocolAdapter = {
  protocol: "copilot-native",

  async createChatCompletions({
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
    await ensureCopilotToken(connection, credential)
    const response = await createCopilotChatCompletionsOnce(
      { connection, credential },
      payload,
      signal,
      ctx,
    )
    return { credentialId: credential.id, response } as AdapterChatResult
  },

  async createResponses({ connection, credential, payload, signal, ctx }) {
    await ensureCopilotToken(connection, credential)
    if (!supportsResponsesApiForConnection(payload.model, connection)) {
      const chatResponse = await createCopilotChatCompletionsOnce(
        { connection, credential },
        translateResponsesToChatPayload(payload),
        signal,
        ctx,
      )
      if (isChatCompletionResponse(chatResponse)) {
        return {
          credentialId: credential.id,
          response: translateChatCompletionToResponses(chatResponse, payload),
        } as AdapterResponsesResult
      }
      return {
        credentialId: credential.id,
        response: translateChatCompletionsStreamToResponses(
          chatResponse,
          payload,
        ),
      } as AdapterResponsesResult
    }
    const response = await createCopilotResponsesOnce(
      { connection, credential },
      payload,
      signal,
      ctx,
    )
    return { credentialId: credential.id, response } as AdapterResponsesResult
  },

  async createMessages({ connection, credential, payload, signal, ctx }) {
    await ensureCopilotToken(connection, credential)
    const response = await createCopilotMessagesOnce(
      { connection, credential },
      payload,
      signal,
      ctx,
    )
    return { credentialId: credential.id, response } as AdapterMessagesResult
  },

  async createEmbeddings({ connection, credential, payload, signal }) {
    await ensureCopilotToken(connection, credential)
    const response = await createCopilotEmbeddingsOnce(
      { connection, credential },
      payload,
      signal,
    )
    return {
      credentialId: credential.id,
      response,
    } as AdapterEmbeddingsResult
  },
}
