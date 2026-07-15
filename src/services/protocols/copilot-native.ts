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

import { createCopilotChatCompletionsOnce } from "~/services/copilot/create-chat-completions-once"
import { createCopilotEmbeddingsOnce } from "~/services/copilot/create-embeddings-once"
import { createCopilotMessagesOnce } from "~/services/copilot/create-messages-once"
import { createCopilotResponsesOnce } from "~/services/copilot/create-responses-once"

import { requireTargetAccount } from "./shared"

export const copilotNativeAdapter: ProtocolAdapter = {
  protocol: "copilot-native",

  async createChatCompletions({ target, payload, signal, ctx }) {
    const account = requireTargetAccount(target, "copilot-native")
    const response = await createCopilotChatCompletionsOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },

  async createResponses({ target, payload, signal, ctx }) {
    const account = requireTargetAccount(target, "copilot-native")
    const response = await createCopilotResponsesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterResponsesResult
  },

  async createMessages({ target, payload, signal, ctx }) {
    const account = requireTargetAccount(target, "copilot-native")
    const response = await createCopilotMessagesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterMessagesResult
  },

  async createEmbeddings({ target, payload, signal }) {
    const account = requireTargetAccount(target, "copilot-native")
    const response = await createCopilotEmbeddingsOnce(account, payload, signal)
    return {
      credentialId: account.id,
      response,
    } as AdapterEmbeddingsResult
  },
}
