/**
 * Serves Responses requests via an Anthropic Messages upstream.
 *
 * Thin delegate over {@link createTranslatedCall}: the IR pipeline does the
 * translation and back-translation; this only binds the wires and the adapter
 * executor. Used when a `/v1/responses` request lands on a target whose
 * protocol exposes only the Messages endpoint (e.g. `anthropic-compatible`,
 * `claude-native`).
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ResponsesPayload } from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { createTranslatedCall } from "./wire-pairs"

import type { AnthropicMessagesPayload } from "./anthropic"
import type { AdapterMessagesResult, AdapterResponsesResult } from "./types"

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
  return (await createTranslatedCall({
    source: "responses",
    target: "messages",
    targetPayload: payload,
    connection,
    credential,
    routeTarget: target,
    signal,
    ctx,
    executor: (p) =>
      messagesExecutor({
        target: p.target,
        connection: p.connection,
        credential: p.credential,
        payload: p.payload as AnthropicMessagesPayload,
        signal: p.signal,
        ctx: p.ctx,
      }),
  })) as unknown as AdapterResponsesResult
}
