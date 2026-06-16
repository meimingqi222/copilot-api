/**
 * Copilot Native Protocol Adapter。
 */

import type { Account } from "~/lib/accounts"
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

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("copilot-native adapter: target.account is required")
  }
  return account
}

export const copilotNativeAdapter: ProtocolAdapter = {
  protocol: "copilot-native",

  // eslint-disable-next-line max-params
  async createChatCompletions(
    target,
    _connection,
    _credential,
    payload,
    signal,
    ctx,
  ) {
    const account = extractAccount(target)
    const response = await createCopilotChatCompletionsOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },

  // eslint-disable-next-line max-params
  async createResponses(
    target,
    _connection,
    _credential,
    payload,
    signal,
    ctx,
  ) {
    const account = extractAccount(target)
    const response = await createCopilotResponsesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterResponsesResult
  },

  // eslint-disable-next-line max-params
  async createMessages(target, _connection, _credential, payload, signal, ctx) {
    const account = extractAccount(target)
    const response = await createCopilotMessagesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterMessagesResult
  },

  async createEmbeddings(target, _connection, _credential, payload, signal) {
    const account = extractAccount(target)
    const response = await createCopilotEmbeddingsOnce(account, payload, signal)
    return {
      credentialId: account.id,
      response,
    } as AdapterEmbeddingsResult
  },
}
