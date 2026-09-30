/**
 * Shared helper for serving Responses requests via a Messages upstream.
 * Mirrors `responses-via-chat.ts`: converts a Responses payload -> Anthropic
 * Messages payload, delegates to the adapter's `createMessages`, then converts
 * the Messages result back to Responses format (streaming or non-streaming).
 *
 * Used by the dispatch layer when a `/v1/responses` request lands on a target
 * whose protocol exposes only the Messages endpoint (e.g.
 * `anthropic-compatible`, `claude-native`).
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ResponsesPayload } from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import { planTranslation, recordTranslationLosses } from "~/services/ir"
import {
  decodeMessagesResponse,
  decodeMessagesStream,
  encodeMessagesRequest,
} from "~/services/ir/codecs/messages-chat"
import { decodeResponsesRequest } from "~/services/ir/codecs/responses/request"
import { encodeResponsesResult } from "~/services/ir/codecs/responses/result"
import { encodeResponsesStream } from "~/services/ir/codecs/responses/stream"

import type { AdapterMessagesResult, AdapterResponsesResult } from "./types"

import type { AnthropicMessagesPayload, AnthropicResponse } from "./anthropic"

import { isAsyncIterable } from "./anthropic"

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

interface ResponsesViaMessagesParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ResponsesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  messagesExecutor: MessagesExecutor
}

export async function createResponsesViaMessages(
  params: ResponsesViaMessagesParams,
): Promise<AdapterResponsesResult> {
  const {
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
    messagesExecutor,
  } = params

  const requestIR = decodeResponsesRequest(payload)
  const plan = planTranslation(requestIR, {
    wire: "messages",
    issuer: connection.id,
    model: target.upstreamModelId,
  })
  recordTranslationLosses(ctx?.c, plan.losses)
  if (!plan.accepted) {
    throw new LocalPayloadUnsupportedError(
      plan.losses.records
        .filter((record) => record.action === "reject")
        .map((record) => record.reason)
        .join("; ") || "Messages target cannot preserve the request",
    )
  }
  const messagesPayload = encodeMessagesRequest(requestIR, {
    stream: payload.stream === true,
    issuer: connection.id,
  })
  const result = await messagesExecutor({
    target,
    connection,
    credential,
    payload: messagesPayload,
    signal,
    ctx,
  })

  if (!isAsyncIterable(result.response)) {
    return {
      credentialId: result.credentialId,
      response: encodeResponsesResult(
        decodeMessagesResponse(result.response as unknown as AnthropicResponse),
        requestIR,
      ),
    }
  }

  return {
    credentialId: result.credentialId,
    response: encodeResponsesStream(
      decodeMessagesStream(result.response),
      requestIR,
    ),
  }
}
