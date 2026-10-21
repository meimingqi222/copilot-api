/**
 * Serves Responses requests via a Chat Completions upstream.
 *
 * Thin delegate over {@link createTranslatedCall}. Memory-diagnostics trace
 * phases for `responses -> chat` are wired in `wire-pairs.ts`.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { ResponsesPayload } from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { createTranslatedCall } from "./wire-pairs"

import type { AdapterChatResult, AdapterResponsesResult } from "./types"

interface ChatExecutorParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}

type ChatExecutor = (params: ChatExecutorParams) => Promise<AdapterChatResult>

interface ResponsesViaChatParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ResponsesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  chatExecutor: ChatExecutor
}

export async function createResponsesViaChat(
  params: ResponsesViaChatParams,
): Promise<AdapterResponsesResult> {
  const { target, connection, credential, payload, signal, ctx, chatExecutor } =
    params
  return (await createTranslatedCall({
    source: "responses",
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
  })) as unknown as AdapterResponsesResult
}
