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
  const result = await chatExecutor({
    target,
    connection,
    credential,
    payload: translateResponsesToChatPayload(payload),
    signal,
    ctx,
  })

  if (isChatCompletionResponse(result.response)) {
    const response = result.response as ChatCompletionResponse
    return {
      credentialId: result.credentialId,
      response: translateChatCompletionToResponses(response, payload),
    }
  }

  const stream = result.response as AsyncIterable<CopilotStreamEvent>
  return {
    credentialId: result.credentialId,
    response: translateChatCompletionsStreamToResponses(stream, payload),
  }
}
