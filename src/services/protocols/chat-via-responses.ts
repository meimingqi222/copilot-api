/**
 * Shared helper for protocol adapters that only implement `createResponses`
 * but need to accept Chat Completions requests.
 *
 * Converts Chat Completions payload → Responses payload, delegates to the
 * adapter's `createResponses`, then converts the Responses result back to
 * Chat Completions format (streaming or non-streaming).
 *
 * Used by xAI, Codex, and other `native_responses`-only providers.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type {
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { translateToResponsesPayload } from "~/services/copilot/chat-to-responses"
import {
  translateResponsesStreamToChatCompletions,
  translateResponsesToChatCompletion,
} from "~/services/copilot/responses-to-chat"

import type { AdapterChatResult, AdapterResponsesResult } from "./types"

interface ResponsesExecutorParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ResponsesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}

type ResponsesExecutor = (
  params: ResponsesExecutorParams,
) => Promise<AdapterResponsesResult>

interface ChatViaResponsesParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  responsesExecutor: ResponsesExecutor
}

/**
 * Type guard: distinguishes a non-streaming ResponsesResponse object from
 * an AsyncIterable stream. A ResponsesResponse is a plain object; a stream
 * has `Symbol.asyncIterator`.
 */
function isResponsesResponse(value: unknown): value is ResponsesResponse {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(Symbol.asyncIterator in value)
  )
}

export async function createChatViaResponses(
  params: ChatViaResponsesParams,
): Promise<AdapterChatResult> {
  const {
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
    responsesExecutor,
  } = params

  const responsesPayload = translateToResponsesPayload(payload)
  const result = await responsesExecutor({
    target,
    connection,
    credential,
    payload: responsesPayload,
    signal,
    ctx,
  })

  if (isResponsesResponse(result.response)) {
    const chatResponse = translateResponsesToChatCompletion(result.response)
    return { credentialId: result.credentialId, response: chatResponse }
  }

  const chatStream = translateResponsesStreamToChatCompletions(
    result.response,
    payload.model,
  )
  return { credentialId: result.credentialId, response: chatStream }
}
