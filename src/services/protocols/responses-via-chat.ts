import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import {
  translateChatCompletionToResponses,
  translateChatCompletionsStreamToResponses,
  translateResponsesToChatPayload,
} from "~/services/copilot/responses-api"

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

function isChatCompletionResponse(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(Symbol.asyncIterator in value)
  )
}

export async function createResponsesViaChat(
  params: ResponsesViaChatParams,
): Promise<AdapterResponsesResult> {
  const { target, connection, credential, payload, signal, ctx, chatExecutor } =
    params
  updateMemoryTrace(ctx?.memoryTraceId, "responses_to_chat_start", {
    inputItems: Array.isArray(payload.input) ? payload.input.length : 1,
  })
  // Mirrors createMessagesViaChat: replayed reasoning survives as
  // reasoning_content for every upstream except Copilot, which rejects
  // reasoning in history.
  const chatPayload = translateResponsesToChatPayload(payload, {
    preserveHistoricalReasoning: target.protocol !== "copilot-native",
  })
  updateMemoryTrace(ctx?.memoryTraceId, "responses_to_chat_complete", {
    messageCount: chatPayload.messages.length,
    toolCount: chatPayload.tools?.length ?? 0,
  })
  const result = await chatExecutor({
    target,
    connection,
    credential,
    payload: chatPayload,
    signal,
    ctx,
  })

  if (isChatCompletionResponse(result.response)) {
    const response = result.response as ChatCompletionResponse
    updateMemoryTrace(ctx?.memoryTraceId, "chat_to_responses_start", {
      responseMode: "non_streaming",
    })
    const translated = translateChatCompletionToResponses(response, payload)
    updateMemoryTrace(ctx?.memoryTraceId, "chat_to_responses_complete", {
      responseMode: "non_streaming",
    })
    return {
      credentialId: result.credentialId,
      response: translated,
    }
  }

  const stream = result.response as AsyncIterable<CopilotStreamEvent>
  return {
    credentialId: result.credentialId,
    response: translateChatCompletionsStreamToResponses(
      stream,
      payload,
      ctx?.memoryTraceId,
    ),
  }
}
