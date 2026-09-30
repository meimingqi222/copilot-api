/**
 * Shared helper for serving Anthropic Messages requests via a Responses
 * upstream. Mirrors `messages-via-chat.ts`: converts an Anthropic Messages
 * payload -> Responses payload, delegates to the adapter's `createResponses`,
 * then converts the Responses result back to Anthropic format (streaming or
 * non-streaming).
 *
 * Used by the dispatch layer when a `/v1/messages` request lands on a target
 * whose protocol exposes only the Responses endpoint (e.g.
 * `openai-responses-compatible`, `codex-native`, `xai-native`).
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import { planTranslation, recordTranslationLosses } from "~/services/ir"
import {
  decodeMessagesRequest,
  encodeMessagesResponse,
  encodeMessagesStream,
} from "~/services/ir/codecs/messages-chat"
import { encodeResponsesRequest } from "~/services/ir/codecs/responses/request"
import { decodeResponsesResult } from "~/services/ir/codecs/responses/result"
import { decodeResponsesStream } from "~/services/ir/codecs/responses/stream"

import type { AdapterMessagesResult, AdapterResponsesResult } from "./types"

import type { AnthropicMessagesPayload } from "./anthropic"

import { estimateInputTokens } from "./messages-via-chat"

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

interface MessagesViaResponsesParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: AnthropicMessagesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  responsesExecutor: ResponsesExecutor
}

/** A non-streaming ResponsesResponse is a plain object; a stream has asyncIterator. */
function isResponsesResponse(value: unknown): value is ResponsesResponse {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(Symbol.asyncIterator in value)
  )
}

export async function createMessagesViaResponses(
  params: MessagesViaResponsesParams,
): Promise<AdapterMessagesResult> {
  const {
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
    responsesExecutor,
  } = params

  const requestIR = decodeMessagesRequest(payload)
  const plan = planTranslation(requestIR, {
    wire: "responses",
    issuer: connection.id,
    model: target.upstreamModelId,
  })
  recordTranslationLosses(ctx?.c, plan.losses)
  if (!plan.accepted) {
    throw new LocalPayloadUnsupportedError(
      plan.losses.records
        .filter((record) => record.action === "reject")
        .map((record) => record.reason)
        .join("; ") || "Responses target cannot preserve the request",
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
    const anthropicResponse = encodeMessagesResponse(
      decodeResponsesResult(result.response),
    )
    return {
      credentialId: result.credentialId,
      response: anthropicResponse as unknown as Record<string, unknown>,
    }
  }

  // Streaming: translate each Responses event into Anthropic events and yield
  // them as SSE frames ({data, event}) — the shape every messages-protocol
  // consumer (connection-handler) and sibling adapters (safeSseStream) use.
  const upstream = result.response as AsyncIterable<CopilotStreamEventLike>
  const anthropicStream = (async function* (): AsyncIterable<{
    data: string
    event: string
  }> {
    for await (const event of encodeMessagesStream(
      decodeResponsesStream(upstream, payload.model),
      estimateInputTokens(payload),
    )) {
      yield { data: JSON.stringify(event), event: event.type }
    }
  })()
  return { credentialId: result.credentialId, response: anthropicStream }
}
