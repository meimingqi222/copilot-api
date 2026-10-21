/**
 * Serves Anthropic Messages requests via a Chat Completions upstream.
 *
 * Thin delegate over {@link createTranslatedCall}. The structured delta twin
 * hint (`collectChatStreamTwin`) is applied by `wire-pairs.ts` for `messages -> chat`.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { createTranslatedCall } from "./wire-pairs"

import type { AnthropicMessagesPayload } from "./anthropic"
import type { AdapterChatResult, AdapterMessagesResult } from "./types"

interface ChatExecutorParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}

type ChatExecutor = (params: ChatExecutorParams) => Promise<AdapterChatResult>

interface MessagesViaChatParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: AnthropicMessagesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  chatExecutor: ChatExecutor
}

export async function createMessagesViaChat(
  params: MessagesViaChatParams,
): Promise<AdapterMessagesResult> {
  const { target, connection, credential, payload, signal, ctx, chatExecutor } =
    params
  return (await createTranslatedCall({
    source: "messages",
    target: "chat",
    targetPayload: payload,
    connection,
    credential,
    routeTarget: target,
    signal,
    ctx,
    executor: (p) =>
      chatExecutor({
        target: p.target,
        connection: p.connection,
        credential: p.credential,
        payload: p.payload as ChatCompletionsPayload,
        signal: p.signal,
        ctx: p.ctx,
      }),
  })) as unknown as AdapterMessagesResult
}
