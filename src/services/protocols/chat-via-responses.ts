/**
 * Serves Chat Completions requests via a Responses upstream.
 *
 * Thin delegate over {@link createTranslatedCall}: the generic IR pipeline does
 * the decode/plan/encode/execute/back-translate work, and this file only binds
 * the source/target wires and the adapter executor. Used by xAI, Codex, and
 * other `native_responses`-only providers, and by the dispatch layer when a
 * `/v1/chat/completions` request fails over to a responses-only target.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { ResponsesPayload } from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { createTranslatedCall } from "./wire-pairs"

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
  return (await createTranslatedCall({
    source: "chat",
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
  })) as unknown as AdapterChatResult
}
