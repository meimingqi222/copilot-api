import type { Context } from "hono"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"

import {
  canonicalModelId,
  parseModelReference,
} from "~/lib/route-target/model-reference"
import {
  inferInitiatorFromChatMessages,
  inferInitiatorFromResponsesPayload,
} from "~/lib/initiator-header"
import { accountManagedModelPrefix } from "~/lib/provider-connections"
import { runRedactedCall } from "~/lib/redaction/context"
import { connectionModelSupportsEndpoint } from "~/lib/route-target/model-support"
import { hasVisionInput } from "~/services/copilot/create-responses-once"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"
import { createResponsesViaChat } from "~/services/protocols/responses-via-chat"
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
  /**
   * V2 内联压缩 turn（`compaction_trigger` 随普通 /responses 进来，含 WS
   * 路径）：adapter 侧走 compact 分支（跳上游 WS、不注入 replay、不记
   * transcript、不链 previous_response_id），上游一律 HTTP。
   */
  compact?: boolean
}

export function createResponses(
  payload: ResponsesPayload,
  options: CreateResponsesOptions,
): ReturnType<typeof createPreparedResponses> {
  return runRedactedCall(payload, options.c, (prepared) =>
    createPreparedResponses(prepared, options),
  )
}

const createPreparedResponses = async (
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

  initializeProtocolAdapters()
  const adapter = getProtocolAdapter(connection.protocol)

  // 该模型在这个 connection 上不支持 responses 端点时，走共享的
  // Responses→Chat 翻译路径（IR codec），而不是 adapter 私有翻译器。
  if (
    !connectionModelSupportsEndpoint(
      routedPayload.model,
      connection,
      "responses",
    )
  ) {
    const createChat = adapter?.createChatCompletions?.bind(adapter)
    if (!createChat) {
      throw new Error(
        `Protocol "${connection.protocol}" does not support responses via chat`,
      )
    }

    const target = buildDirectAdapterTarget({
      connection,
      credential,
      payloadModel: routedPayload.model,
      nativeModelId: parseModelReference(
        routedPayload.model,
        accountManagedModelPrefix(connection),
      ).nativeModelId,
      endpoint: "chat",
    })

    const result = await createResponsesViaChat({
      target,
      connection,
      credential,
      payload: routedPayload,
      signal: options.signal,
      ctx: {
        initiator:
          options.initiatorOverride
          ?? inferInitiatorFromResponsesPayload(routedPayload),
        forwardedHeaders: options.forwardedHeaders,
        c: options.c,
        memoryTraceId: options.memoryTraceId,
      },
      chatExecutor: ({ payload: chatPayload }) =>
        createChat({
          target,
          connection,
          credential,
          payload: chatPayload,
          signal: options.signal,
          ctx: {
            initiator:
              options.initiatorOverride
              ?? inferInitiatorFromChatMessages(chatPayload.messages),
            enableVision: chatPayload.messages.some(
              (message) =>
                typeof message.content !== "string"
                && message.content?.some(
                  (content) => content.type === "image_url",
                ),
            ),
            forwardedHeaders: options.forwardedHeaders,
            c: options.c,
            memoryTraceId: options.memoryTraceId,
          },
        }),
    })

    return { accountId: connection.id, response: result.response }
  }

  const enableVision = hasVisionInput(routedPayload)
  const initiator =
    options.initiatorOverride
    ?? inferInitiatorFromResponsesPayload(routedPayload)

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
      forceUpstreamHttp: options.forceUpstreamHttp || options.compact,
      compact: options.compact,
    },
  })

  return {
    accountId: connection.id,
    response: result.response,
  }
}
