import type { Context } from "hono"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { canonicalModelId, parseModelReference } from "~/lib/legacy-accounts"
import { accountManagedModelPrefix } from "~/lib/provider-connections"
import { isChatCompletionResponse } from "~/lib/utils"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { hasVisionInput } from "~/services/copilot/create-responses-once"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"
import {
  supportsResponsesApiForConnection,
  translateChatCompletionToResponses,
  translateChatCompletionsStreamToResponses,
  translateResponsesToChatPayload,
  type CopilotStreamEventLike,
  type ResponsesPayload,
  type ResponsesResponse,
} from "~/services/copilot/responses-api"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"
import { buildDirectAdapterTarget } from "~/services/providers/adapter-target"

interface CreateResponsesOptions {
  connection: ProviderConnection
  credential: ApiCredential
  signal?: AbortSignal
  initiatorOverride?: "agent" | "user"
  forwardedHeaders?: Record<string, string | undefined>
  c?: Context
  /** Client used Responses WebSocket transport. */
  downstreamWebsocket?: boolean
  /** Sticky key for upstream WS connection reuse. */
  executionSessionId?: string
  /** Isolation scope for reconnectable in-memory Responses transcripts. */
  transcriptScopeId?: string
  /** Correlates memory diagnostics for one Responses WebSocket turn. */
  memoryTraceId?: string
  /**
   * Force upstream HTTP POST (skip the WS path) for this call. Used by the WS
   * handler's same-account recovery after a lazy connection failure.
   */
  forceUpstreamHttp?: boolean
}

export const createResponses = async (
  payload: ResponsesPayload,
  options: CreateResponsesOptions,
): Promise<{
  accountId: string
  response: ResponsesResponse | AsyncIterable<CopilotStreamEventLike>
}> => {
  const routedPayload = {
    ...payload,
    model: canonicalModelId(payload.model),
  }
  const { connection, credential } = options

  if (!supportsResponsesApiForConnection(routedPayload.model, connection)) {
    const chatPayload = translateResponsesToChatPayload(routedPayload)
    const result = await createChatCompletions(chatPayload, {
      connection,
      credential,
      signal: options.signal,
      initiatorOverride: options.initiatorOverride,
      c: options.c,
      forwardedHeaders: options.forwardedHeaders,
      memoryTraceId: options.memoryTraceId,
    })

    if (isChatCompletionResponse(result.response)) {
      return {
        accountId: result.accountId,
        response: translateChatCompletionToResponses(
          result.response,
          routedPayload,
        ),
      }
    }

    return {
      accountId: result.accountId,
      response: translateChatCompletionsStreamToResponses(
        result.response,
        routedPayload,
      ),
    }
  }

  const enableVision = hasVisionInput(routedPayload)
  const initiator =
    options.initiatorOverride
    ?? inferInitiatorFromResponsesPayload(routedPayload)

  initializeProtocolAdapters()
  const adapter = getProtocolAdapter(connection.protocol)
  if (!adapter?.createResponses) {
    throw new Error(
      `Protocol "${connection.protocol}" does not support responses`,
    )
  }

  const nativeModelId = parseModelReference(
    routedPayload.model,
    accountManagedModelPrefix(connection),
  ).nativeModelId
  const target = buildDirectAdapterTarget({
    connection,
    credential,
    payloadModel: routedPayload.model,
    nativeModelId,
    endpoint: "responses",
  })

  const result = await adapter.createResponses({
    target,
    connection,
    credential,
    payload: routedPayload,
    signal: options.signal,
    ctx: {
      initiator,
      enableVision,
      forwardedHeaders: options.forwardedHeaders,
      c: options.c,
      downstreamWebsocket: options.downstreamWebsocket,
      executionSessionId: options.executionSessionId,
      transcriptScopeId: options.transcriptScopeId,
      memoryTraceId: options.memoryTraceId,
      forceUpstreamHttp: options.forceUpstreamHttp,
    },
  })

  return {
    accountId: result.credentialId,
    response: result.response,
  }
}
