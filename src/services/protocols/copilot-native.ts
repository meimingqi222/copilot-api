/**
 * Copilot Native Protocol Adapter。
 */

import type {
  AdapterChatResult,
  AdapterEmbeddingsResult,
  AdapterMessagesResult,
  AdapterResponsesResult,
  ProtocolAdapter,
} from "~/services/protocols/types"

import { connectionToAccount } from "~/lib/provider-connections"
import { createCopilotChatCompletionsOnce } from "~/services/copilot/create-chat-completions-once"
import { createCopilotEmbeddingsOnce } from "~/services/copilot/create-embeddings-once"
import { createCopilotMessagesOnce } from "~/services/copilot/create-messages-once"
import { createCopilotResponsesOnce } from "~/services/copilot/create-responses-once"

export const copilotNativeAdapter: ProtocolAdapter = {
  protocol: "copilot-native",

  async createChatCompletions({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    const response = await createCopilotChatCompletionsOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },

  async createResponses({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    const response = await createCopilotResponsesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterResponsesResult
  },

  async createMessages({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    const response = await createCopilotMessagesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterMessagesResult
  },

  async createEmbeddings({ connection, payload, signal }) {
    const account = connectionToAccount(connection)
    const response = await createCopilotEmbeddingsOnce(account, payload, signal)
    return {
      credentialId: account.id,
      response,
    } as AdapterEmbeddingsResult
  },
}
