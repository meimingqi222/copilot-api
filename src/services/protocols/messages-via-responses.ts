/**
 * Serves Anthropic Messages requests via a Responses upstream.
 *
 * Thin delegate over {@link createTranslatedCall}: the IR pipeline does the
 * translation and back-translation; this only binds the wires and the adapter
 * executor. Used when a `/v1/messages` request lands on a target whose protocol
 * exposes only the Responses endpoint (e.g. `openai-responses-compatible`,
 * `codex-native`, `xai-native`).
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
  return (await createTranslatedCall({
    source: "messages",
    target: "responses",
    targetPayload: payload,
    connection,
    credential,
    routeTarget: target,
    signal,
    ctx,
    executor: (p) =>
      responsesExecutor({
        target: p.target,
        connection: p.connection,
        credential: p.credential,
        payload: p.payload as ResponsesPayload,
        signal: p.signal,
        ctx: p.ctx,
      }),
  })) as unknown as AdapterMessagesResult
}
