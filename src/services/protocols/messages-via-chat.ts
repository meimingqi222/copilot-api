/**
 * Serves Anthropic Messages requests via a Chat Completions upstream.
 *
 * Thin delegate over {@link createTranslatedCall}: the IR pipeline plans the
 * translation, enforces the capability preflight, runs search orchestration,
 * and renders the Anthropic SSE frame shape. This file only binds the wires,
 * the adapter executor, and the one per-direction hint below — the producer is
 * asked for its structured delta twin so the stream translator can skip
 * re-parsing SSE JSON it just serialized (a per-token win on long streams;
 * other adapters ignore the hint and stay on the JSON path).
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
    decorateExecutorContext: (c) => ({ ...c, collectChatStreamTwin: true }),
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
