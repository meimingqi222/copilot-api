/**
 * Serves Responses requests via a Chat Completions upstream.
 *
 * Thin delegate over {@link createTranslatedCall}: the IR pipeline does the
 * translation, capability preflight, search orchestration, and back-translation.
 * The only per-direction behavior left here is the memory-diagnostics trace,
 * emitted through the `onPhase` hook.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { ResponsesPayload } from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { updateMemoryTrace } from "~/lib/memory-diagnostics"

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
    onPhase: (phase, details) => {
      if (phase === "request_decoded")
        updateMemoryTrace(ctx?.memoryTraceId, "responses_to_chat_start", {
          inputItems: Array.isArray(payload.input) ? payload.input.length : 1,
        })
      else if (phase === "request_encoded") {
        const chat = details.targetPayload as ChatCompletionsPayload
        updateMemoryTrace(ctx?.memoryTraceId, "responses_to_chat_complete", {
          messageCount: chat.messages.length,
          toolCount: chat.tools?.length ?? 0,
        })
      } else if (phase === "result_decoded")
        updateMemoryTrace(ctx?.memoryTraceId, "chat_to_responses_start", {
          responseMode: "non_streaming",
        })
      else if (phase === "complete")
        updateMemoryTrace(ctx?.memoryTraceId, "chat_to_responses_complete", {
          responseMode: "non_streaming",
        })
    },
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
