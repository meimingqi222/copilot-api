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
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type {
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import { planTranslation, recordTranslationLosses } from "~/services/ir"
import { decodeChatRequest } from "~/services/ir/codecs/messages-chat/request"
import { encodeChatResponse } from "~/services/ir/codecs/messages-chat/response"
import { encodeChatStream } from "~/services/ir/codecs/messages-chat/stream"
import { encodeResponsesRequest } from "~/services/ir/codecs/responses/request"
import { decodeResponsesResult } from "~/services/ir/codecs/responses/result"
import { decodeResponsesStream } from "~/services/ir/codecs/responses/stream"

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

  const requestIR = decodeChatRequest(payload)
  const plan = planTranslation(requestIR, {
    wire: "responses",
    issuer: connection.id,
    model: target.upstreamModelId,
  })
  recordTranslationLosses(ctx?.c, plan.losses)
  if (!plan.accepted) {
    throw new LocalPayloadUnsupportedError(
      plan.losses.records.find((record) => record.action === "reject")?.reason
        ?? "Responses target cannot preserve this request",
    )
  }
  const responsesPayload = {
    ...encodeResponsesRequest(requestIR),
    stream: payload.stream,
  }
  const result = await responsesExecutor({
    target,
    connection,
    credential,
    payload: responsesPayload,
    signal,
    ctx,
  })

  if (isResponsesResponse(result.response)) {
    const chatResponse = encodeChatResponse(
      decodeResponsesResult(result.response),
    )
    return { credentialId: result.credentialId, response: chatResponse }
  }

  const chatStream = encodeChatStream(
    decodeResponsesStream(result.response, payload.model),
  )
  return { credentialId: result.credentialId, response: chatStream }
}
