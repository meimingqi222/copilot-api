import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import type { ResponsesPayload } from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { LocalPayloadUnsupportedError } from "~/lib/error"
import { planTranslation, recordTranslationLosses } from "~/services/ir"
import { encodeChatRequest } from "~/services/ir/codecs/messages-chat/request"
import { decodeChatResponse } from "~/services/ir/codecs/messages-chat/response"
import { decodeChatStream } from "~/services/ir/codecs/messages-chat/stream"
import { decodeResponsesRequest } from "~/services/ir/codecs/responses/request"
import { encodeResponsesResult } from "~/services/ir/codecs/responses/result"
import { encodeResponsesStream } from "~/services/ir/codecs/responses/stream"
import {
  needsSearchOrchestration,
  runSearchAwareResult,
  runSearchAwareStream,
} from "~/services/search/orchestrate"
import { listSearchers } from "~/services/search/searcher"

import { wireSpec } from "./wire-pairs"

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
  const requestIR = decodeResponsesRequest(payload)
  const searchers = listSearchers()
  const orchestrate =
    searchers.length > 0 && needsSearchOrchestration(requestIR, "chat")
  const plan = planTranslation(requestIR, {
    wire: "chat",
    issuer: connection.id,
    model: target.upstreamModelId,
    ...(orchestrate && { orchestratedWebSearch: true }),
  })
  recordTranslationLosses(ctx?.c, plan.losses)
  if (!plan.accepted) {
    throw new LocalPayloadUnsupportedError(
      plan.losses.records.find((record) => record.action === "reject")?.reason
        ?? "Chat target cannot preserve this request",
    )
  }
  const executeChat = (chatPayload: ChatCompletionsPayload) =>
    chatExecutor({
      target,
      connection,
      credential,
      payload: chatPayload,
      signal,
      ctx,
    })

  if (orchestrate) {
    const searchParams = {
      request: requestIR,
      spec: wireSpec("chat"),
      searchers,
      execute: (chatPayload: unknown) =>
        executeChat(chatPayload as ChatCompletionsPayload),
      signal,
      initiator: ctx?.initiator,
    }
    if (payload.stream === true) {
      const stream = runSearchAwareStream(searchParams)
      return {
        credentialId: credential.id,
        response: encodeResponsesStream(stream, requestIR),
      }
    }
    const { credentialId, result } = await runSearchAwareResult(searchParams)
    return {
      credentialId,
      response: encodeResponsesResult(result, requestIR),
    }
  }

  const chatPayload = encodeChatRequest(requestIR, {
    preserveHistoricalReasoning: target.protocol !== "copilot-native",
    stream: payload.stream === true,
  })
  updateMemoryTrace(ctx?.memoryTraceId, "responses_to_chat_complete", {
    messageCount: chatPayload.messages.length,
    toolCount: chatPayload.tools?.length ?? 0,
  })
  const result = await executeChat(chatPayload)

  if (isChatCompletionResponse(result.response)) {
    const response = result.response as ChatCompletionResponse
    updateMemoryTrace(ctx?.memoryTraceId, "chat_to_responses_start", {
      responseMode: "non_streaming",
    })
    const translated = encodeResponsesResult(
      decodeChatResponse(response),
      requestIR,
    )
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
    response: encodeResponsesStream(decodeChatStream(stream), requestIR),
  }
}
