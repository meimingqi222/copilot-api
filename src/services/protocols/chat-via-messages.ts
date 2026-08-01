/**
 * Shared helper for serving OpenAI Chat Completions requests via an Anthropic
 * Messages upstream. Mirrors `messages-via-chat.ts`: converts a Chat
 * Completions payload -> Anthropic Messages payload, delegates to the
 * adapter's `createMessages`, then converts the Anthropic result back to
 * OpenAI format (streaming or non-streaming).
 *
 * Used by the dispatch layer when a `/v1/chat/completions` request fails over
 * to a target whose adapter only implements `createMessages` (e.g. a
 * claude-native or anthropic-compatible connection), so cross-protocol
 * fallback is transparent.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import type { AnthropicMessagesPayload, AnthropicResponse } from "./anthropic"
import type { AdapterChatResult, AdapterMessagesResult } from "./types"

import {
  translateAnthropicResponseToChat,
  translateAnthropicStreamToChatEvents,
  translateChatPayloadToAnthropic,
} from "./openai"

interface MessagesExecutorParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: AnthropicMessagesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}

type MessagesExecutor = (
  params: MessagesExecutorParams,
) => Promise<AdapterMessagesResult>

interface ChatViaMessagesParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  messagesExecutor: MessagesExecutor
}

/** A non-streaming AnthropicResponse is a plain object; a stream has asyncIterator. */
function isAnthropicResponse(value: unknown): value is AnthropicResponse {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(Symbol.asyncIterator in value)
  )
}

export async function createChatViaMessages(
  params: ChatViaMessagesParams,
): Promise<AdapterChatResult> {
  const {
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
    messagesExecutor,
  } = params

  const anthropicPayload = translateChatPayloadToAnthropic(payload)
  const result = await messagesExecutor({
    target,
    connection,
    credential,
    payload: anthropicPayload,
    signal,
    ctx,
  })

  if (isAnthropicResponse(result.response)) {
    return {
      credentialId: result.credentialId,
      response: translateAnthropicResponseToChat(result.response),
    }
  }

  const chatStream = translateAnthropicStreamToChatEvents(
    result.response as AsyncIterable<unknown>,
  )
  return { credentialId: result.credentialId, response: chatStream }
}
