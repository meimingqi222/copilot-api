/**
 * Serves Chat Completions requests via an Anthropic Messages upstream.
 *
 * Thin delegate over {@link createTranslatedCall}. Default prompt-cache
 * breakpoint injection for `chat -> messages` lives in `wire-pairs.ts`.
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
  return (await createTranslatedCall({
    source: "chat",
    target: "messages",
    targetPayload: payload,
    connection,
    credential,
    routeTarget: target,
    signal,
    ctx,
    executor: (p) =>
      messagesExecutor({
        target: p.target,
        connection: p.connection,
        credential: p.credential,
        payload: p.payload as AnthropicMessagesPayload,
        signal: p.signal,
        ctx: p.ctx,
      }),
  })) as unknown as AdapterChatResult
}
