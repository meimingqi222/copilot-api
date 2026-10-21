import type { Context } from "hono"

import {
  observeResponseServiceTier,
  observeServiceTierStream,
  recordRoutedServiceTier,
  recordSentServiceTier,
} from "~/lib/service-tier-trace"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import {
  applyIdentityConfuseBody,
  applyIdentityConfuseHeaders,
  restoreIdentityConfuseResponse,
  type IdentityConfuseState,
} from "~/lib/cache/identity-confuse"
import {
  cacheReasoningReplayItems,
  deleteReasoningReplayItems,
  getReasoningReplayItems,
  injectReasoningReplayItems,
} from "~/lib/cache/reasoning-replay-cache"
import { HTTPError } from "~/lib/error"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import {
  getCredentialContextString,
  getConnectionSettings,
} from "~/lib/provider-connections"
import { normalizeResponsesStreamIds } from "~/services/protocols/responses/normalize-stream"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { hasCompactionTrigger } from "~/services/responses/compact"
import {
  collectResponsesFromEventStream,
  collectResponsesFromSseResponse,
} from "~/services/responses/sse-collector"
import {
  appendCodexTranscript,
  buildResponsesTranscriptInput,
  codexTranscriptKey,
  countUnansweredToolCalls,
  getCodexTranscript,
  pruneUnansweredToolCalls,
  recordResponsesTranscriptInStream,
  recordTranscriptCheckpoint,
  resolveResponsesTranscriptSessionId,
} from "~/services/responses/transcript-cache"
import {
  applyCodexWebsocketHeaders,
  destroyUpstreamWebsocketSession,
  isAbortLikeError,
  openUpstreamResponsesWebsocketTurn,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"
import { isChainedTurnUpstreamError } from "~/services/responses/upstream-ws-error"
import { classifyWsFailure } from "~/services/responses/ws-failure"

import {
  finalizeCodexOutboundBody,
  postCodexResponses,
  runLegacyCompactEntry,
} from "./compact"
import { buildCodexHeaders } from "./headers"
import {
  resolveCodexExtraHeaders,
  resolveCodexSessionHeaders,
  withCodexRoutingHint,
} from "~/services/codex/session-headers"
import { logCodexReasoningSummary, wrapCodexStream } from "./stream-wrap"
import {
  assertChainedHttpReplayAvailable,
  buildCodexUpstreamBody,
  chainedHttpCodexRequestError,
  isResponsesLiteRequest,
  stripReasoningItems,
} from "./upstream-body"

export { finalizeCodexOutboundBody } from "./compact"

function readForwardedHeader(
  ctx: RequestExecutionContext | undefined,
  name: string,
): string | undefined {
  const value = ctx?.forwardedHeaders?.[name]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isCodexUnauthorized(error: unknown): boolean {
  return error instanceof HTTPError && error.response.status === 401
}

function buildCodexReplayBody(options: {
  upstreamBody: Record<string, unknown>
  fullInputThisTurn: Array<unknown>
  chained: boolean
  memoryTraceId?: string
}): { body: Record<string, unknown> | undefined } {
  const { upstreamBody, fullInputThisTurn, chained, memoryTraceId } = options
  if (!chained) return { body: undefined }

  const strippedInput = stripReasoningItems(fullInputThisTurn)
  const replayInput = pruneUnansweredToolCalls(strippedInput)
  if (replayInput !== strippedInput) {
    const droppedCalls = countUnansweredToolCalls(strippedInput)
    updateMemoryTrace(memoryTraceId, "replay_pruned_unanswered_tool_calls", {
      droppedCalls,
      inputItems: replayInput.length,
    })
    logger.warn(
      `[codex] replay pruned ${droppedCalls} unanswered tool call(s) `
        + `(session with a tool call whose output was never produced)`,
    )
  }

  return {
    body: {
      ...upstreamBody,
      input: replayInput,
      previous_response_id: undefined,
    },
  }
}

export async function createCodexResponsesOnce(
  target: { connection: ProviderConnection; credential: ApiCredential },
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  recordRoutedServiceTier(ctx?.c, payload)
  const result = await createCodexResponsesOnceImpl(
    target,
    payload,
    signal,
    ctx,
  )
  if (!ctx?.c) return result
  if (Symbol.asyncIterator in result)
    return observeServiceTierStream(
      result as AsyncIterable<CopilotStreamEventLike>,
      ctx.c,
    )
  observeResponseServiceTier(ctx.c, result)
  return result
}

async function createCodexResponsesOnceImpl(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  if (connection.protocol !== "codex-native") {
    throw new Error("Codex responses requires a Codex OAuth connection")
  }

  if (ctx?.compact) {
    const record = payload as unknown as Record<string, unknown>
    if (!hasCompactionTrigger(record.input)) {
      return await runLegacyCompactEntry({
        subject: { connection, credential },
        record,
        payload,
        signal,
        ctx,
        runInline: createCodexResponsesOnce,
      })
    }
  }
  const compactInline =
    ctx?.compact === true
    && hasCompactionTrigger(
      (payload as unknown as Record<string, unknown>).input,
    )

  let accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `Codex access token missing for connection "${connection.name}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  const memoryTraceId = ctx?.memoryTraceId
  const settingsBase = getConnectionSettings(connection)?.baseUrl
  const baseUrl = (
    typeof settingsBase === "string" ? settingsBase : (
      CODEX_API_BASE_URL
    )).replace(/\/+$/, "")
  const url = `${baseUrl}/responses`
  const clientStream = payload.stream === true
  const useUpstreamWs =
    !compactInline
    && !ctx?.forceUpstreamHttp
    && shouldUseUpstreamResponsesWebsocket(connection, "codex", ctx)
  const { sessionId, threadId, sessionIdIsStable } = resolveCodexSessionHeaders(
    payload,
    ctx,
  )
  const extraHeaders = resolveCodexExtraHeaders(ctx)
  const responsesLite = isResponsesLiteRequest(payload, ctx)

  let previousResponseId: string | undefined
  if (!compactInline) {
    const previousResponseIdRaw = (
      payload as { previous_response_id?: unknown }
    ).previous_response_id
    if (
      typeof previousResponseIdRaw === "string"
      && previousResponseIdRaw.trim()
    ) {
      previousResponseId = previousResponseIdRaw.trim()
    }
  }

  const upstreamBody = buildCodexUpstreamBody(payload, model, responsesLite)

  const originalCacheKey = (
    payload as unknown as { prompt_cache_key?: unknown }
  ).prompt_cache_key
  const replaySessionKey =
    typeof originalCacheKey === "string" && originalCacheKey.trim() ?
      originalCacheKey.trim()
    : sessionId
  const transcriptScopeId = ctx?.transcriptScopeId?.trim()
  const scopedReplaySessionKey =
    transcriptScopeId && replaySessionKey ?
      `${transcriptScopeId}::${replaySessionKey}`
    : undefined

  const identityState = applyIdentityConfuseBody(
    connection.id,
    payload as unknown as Record<string, unknown>,
    upstreamBody,
  )

  if (scopedReplaySessionKey && !compactInline) {
    const replayItems = await getReasoningReplayItems(
      model,
      scopedReplaySessionKey,
    )
    if (replayItems && replayItems.length > 0) {
      injectReasoningReplayItems(upstreamBody, replayItems)
    }
  }

  logger.debug("[codex] outbound reasoning params", {
    model,
    stream: clientStream,
    useUpstreamWs,
    responsesLite,
    reasoning: upstreamBody.reasoning,
    include: upstreamBody.include,
    inputReasoningItemCount:
      Array.isArray(upstreamBody.input) ?
        (upstreamBody.input as Array<unknown>).filter(
          (item) =>
            item !== null
            && typeof item === "object"
            && (item as { type?: unknown }).type === "reasoning",
        ).length
      : 0,
  })

  const buildHttpHeaders = (token: string): Record<string, string> => {
    const headers: Record<string, string> = {
      ...buildCodexHeaders(token, true, {
        sessionId,
        threadId,
        accountId: getCredentialContextString(connection, "oauthAccountId"),
      }),
      ...extraHeaders,
    }
    applyIdentityConfuseHeaders(headers, identityState)
    return headers
  }
  let httpHeaders = buildHttpHeaders(accessToken)

  const refreshAfterUnauthorized = async (): Promise<boolean> => {
    const refreshed = await ensureOAuthConnectionAccessToken(
      connection,
      credential,
      { forceRefresh: true, failedAccessToken: accessToken },
    )
    if (!refreshed || refreshed === accessToken) return false
    accessToken = refreshed
    httpHeaders = buildHttpHeaders(refreshed)
    return true
  }

  const executionSessionId =
    ctx?.executionSessionId?.trim()
    || sessionId
    || replaySessionKey
    || connection.id

  let transcriptKey: string | undefined
  if (!compactInline && transcriptScopeId && sessionIdIsStable && sessionId) {
    transcriptKey = codexTranscriptKey(
      resolveResponsesTranscriptSessionId(
        executionSessionId,
        sessionId,
        transcriptScopeId,
      ),
    )
  }
  const rawDelta =
    Array.isArray(payload.input) ? (payload.input as Array<unknown>) : []
  const cachedFull =
    previousResponseId && transcriptKey ?
      getCodexTranscript(transcriptKey)
    : undefined
  const transcriptTrackable = !previousResponseId || Boolean(cachedFull)
  const fullInputThisTurn = buildResponsesTranscriptInput(
    cachedFull,
    rawDelta,
    Boolean(transcriptKey),
  )
  const replay = buildCodexReplayBody({
    upstreamBody,
    fullInputThisTurn,
    chained: Boolean(previousResponseId && cachedFull),
    memoryTraceId,
  })
  const fallbackFullInputBody = replay.body
  const httpFallbackBody = fallbackFullInputBody

  assertChainedHttpReplayAvailable(
    previousResponseId,
    useUpstreamWs,
    httpFallbackBody,
    memoryTraceId,
  )

  if (useUpstreamWs) {
    const attemptWs = () =>
      attemptCodexUpstreamWsTurn({
        c: ctx?.c,
        connection,
        url,
        httpHeaders,
        upstreamBody,
        previousResponseId,
        fallbackFullInputBody,
        executionSessionId,
        signal,
        model,
        clientStream,
        scopedReplaySessionKey,
        identityState,
        transcriptKey,
        transcriptTrackable,
        fullInputThisTurn,
        memoryTraceId,
        timingMetricsHeader: readForwardedHeader(
          ctx,
          "x-responsesapi-include-timing-metrics",
        ),
      })

    let wsTurn: Awaited<ReturnType<typeof attemptWs>>
    try {
      wsTurn = await attemptWs()
    } catch (error) {
      if (!isCodexUnauthorized(error) || !(await refreshAfterUnauthorized())) {
        throw error
      }
      destroyUpstreamWebsocketSession(
        "codex",
        connection.id,
        executionSessionId,
      )
      wsTurn = await attemptWs()
    }
    if (wsTurn !== undefined) return wsTurn
  }

  const postResponses = () =>
    postCodexResponses({
      c: ctx?.c,
      connection,
      url,
      headers: httpHeaders,
      upstreamBody,
      httpFallbackBody,
      signal,
      memoryTraceId,
    })

  let response = await postResponses()
  if (response.status === 401 && (await refreshAfterUnauthorized())) {
    response = await postResponses()
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    if (
      response.status === 400
      && errorBody.includes("thinking_signature_invalid")
      && scopedReplaySessionKey
    ) {
      await deleteReasoningReplayItems(model, scopedReplaySessionKey)
    }
    throw new HTTPError(
      "Failed to create Codex responses",
      response,
      errorBody || "(unreadable)",
    )
  }

  if (clientStream) {
    const stream = await safeSseStream(response, detectResponsesStreamError)
    const normalized = normalizeResponsesStreamIds(
      stream as unknown as AsyncIterable<CopilotStreamEventLike>,
    )
    const tracked =
      transcriptKey && transcriptTrackable ?
        recordResponsesTranscriptInStream(
          normalized,
          transcriptKey,
          fullInputThisTurn,
          memoryTraceId,
        )
      : normalized
    return wrapCodexStream(
      tracked,
      model,
      scopedReplaySessionKey,
      identityState,
    )
  }

  const result = await collectResponsesFromSseResponse(response, model)
  if (transcriptKey && transcriptTrackable) {
    recordTranscriptCheckpoint(
      memoryTraceId,
      appendCodexTranscript(
        transcriptKey,
        fullInputThisTurn,
        Array.isArray(result.output) ? result.output : [],
      ),
    )
  }
  logCodexReasoningSummary(
    "[codex] non-stream response reasoning summary",
    result.output as Array<Record<string, unknown>> | undefined,
  )
  if (scopedReplaySessionKey) {
    void cacheReasoningReplayItems(
      model,
      scopedReplaySessionKey,
      result as unknown as Record<string, unknown>,
    )
  }
  if (identityState.enabled) {
    const restored = restoreIdentityConfuseResponse(
      JSON.stringify(result),
      identityState,
    )
    return JSON.parse(restored) as ResponsesResponse
  }
  return result
}

interface CodexWsTurnOptions {
  c?: Context
  connection: ProviderConnection
  url: string
  httpHeaders: Record<string, string>
  upstreamBody: Record<string, unknown>
  previousResponseId?: string
  fallbackFullInputBody?: Record<string, unknown>
  executionSessionId: string
  signal?: AbortSignal
  model: string
  clientStream: boolean
  scopedReplaySessionKey?: string
  identityState: IdentityConfuseState
  transcriptKey?: string
  transcriptTrackable: boolean
  fullInputThisTurn: Array<unknown>
  memoryTraceId?: string
  timingMetricsHeader?: string
}

async function attemptCodexUpstreamWsTurn(
  options: CodexWsTurnOptions,
): Promise<
  AsyncIterable<CopilotStreamEventLike> | ResponsesResponse | undefined
> {
  const {
    connection,
    url,
    httpHeaders,
    upstreamBody,
    previousResponseId,
    fallbackFullInputBody,
    executionSessionId,
    signal,
    model,
    clientStream,
    scopedReplaySessionKey,
    identityState,
    transcriptKey,
    transcriptTrackable,
    fullInputThisTurn,
    memoryTraceId,
    timingMetricsHeader,
  } = options
  const wsBody = finalizeCodexOutboundBody(
    { ...upstreamBody, previous_response_id: previousResponseId },
    "ws",
  )
  const wsFallbackFullInputBody =
    fallbackFullInputBody
    && finalizeCodexOutboundBody(fallbackFullInputBody, "ws")
  const wsHeaders = applyCodexWebsocketHeaders(
    withCodexRoutingHint(httpHeaders, wsBody),
  )
  if (timingMetricsHeader) {
    wsHeaders["x-responsesapi-include-timing-metrics"] = timingMetricsHeader
  }
  try {
    const wsStream = await openUpstreamResponsesWebsocketTurn({
      onSend: (body) => recordSentServiceTier(options.c, body.service_tier),
      provider: "codex",
      accountId: connection.id,
      httpResponsesUrl: url,
      headers: wsHeaders,
      body: wsBody,
      executionSessionId,
      signal,
      previousResponseId,
      fallbackFullInputBody: wsFallbackFullInputBody,
      memoryTraceId,
    })
    const normalized = normalizeResponsesStreamIds(wsStream)
    const tracked =
      transcriptKey && transcriptTrackable ?
        recordResponsesTranscriptInStream(
          normalized,
          transcriptKey,
          fullInputThisTurn,
          memoryTraceId,
        )
      : normalized
    if (clientStream) {
      return wrapCodexStream(
        tracked,
        model,
        scopedReplaySessionKey,
        identityState,
      )
    }
    return await collectResponsesFromEventStream(
      wrapCodexStream(tracked, model, scopedReplaySessionKey, identityState),
      model,
    )
  } catch (error) {
    if (isAbortLikeError(error) || signal?.aborted) throw error
    const failure = classifyWsFailure(error)
    if (isChainedTurnUpstreamError(error) && previousResponseId) {
      throw chainedHttpCodexRequestError()
    }
    if (
      failure.scope === "credential"
      || failure.scope === "request"
      || failure.scope === "local_saturation"
    ) {
      throw error
    }
    if (failure.kind === "connection_limit") {
      destroyUpstreamWebsocketSession(
        "codex",
        connection.id,
        executionSessionId,
      )
    }
    logger.warn(
      `codex websockets: falling back to HTTP: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return undefined
}
