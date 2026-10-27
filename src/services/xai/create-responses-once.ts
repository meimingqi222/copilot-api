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
  cacheReasoningReplayItems,
  getReasoningReplayItems,
  injectReasoningReplayItems,
} from "~/lib/cache/reasoning-replay-cache"
import { HTTPError } from "~/lib/error"
import { serializeUpstreamBody } from "~/lib/upstream-performance"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { resolveTranscriptScopeId } from "~/lib/request-scope"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { normalizeResponsesStreamIds } from "~/services/protocols/responses/normalize-stream"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import { resolveXaiModelId } from "~/services/oauth/model-catalog"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import {
  collectResponsesFromEventStream,
  collectResponsesFromSseResponse,
} from "~/services/responses/sse-collector"
import {
  appendCodexTranscript,
  buildResponsesTranscriptInput,
  getCodexTranscript,
  pruneUnansweredToolCalls,
  recordTranscriptCheckpoint,
  xaiTranscriptKey,
} from "~/services/responses/transcript-cache"
import {
  normalizeXaiReasoningItem,
  normalizeXaiReasoningStream,
} from "~/services/xai/normalize-stream"
import {
  applyXaiWebsocketHeaders,
  destroyUpstreamWebsocketSession,
  isAbortLikeError,
  openUpstreamResponsesWebsocketTurn,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"
import { classifyWsFailure } from "~/services/responses/ws-failure"

import { createXaiCompactOnce, isXaiBadCredentialsHttpError } from "./compact"
import {
  isXaiCliChatProxyBaseUrl,
  xaiChatBaseUrl,
  xaiWsBaseUrl,
} from "./endpoint"
import { buildXaiHeaders } from "./headers"
import {
  sanitizeXaiResponsesBodyWithRefs,
  type XaiNamespaceToolRef,
} from "./sanitize-body"
import { XaiInternalXSearchResponseFilter } from "./search-filter"
import { resolveXaiSessionId } from "./session"
import {
  cacheXaiReasoningReplayInStream,
  filterXaiInternalSearchInStream,
  logCachePrefixDiag,
  recordXaiTranscript,
  restoreXaiNamespaceCallsInStream,
  restoreXaiNamespaceToolCallsInResponse,
} from "./stream-transforms"
import { requireXaiAccessToken } from "./access"

export async function createXaiResponsesOnce(
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
  if (connection.protocol !== "xai-native") {
    throw new Error("xAI responses requires an xAI OAuth connection")
  }

  if (ctx?.compact) {
    return createXaiCompactOnce(
      { connection, credential },
      payload as unknown as Record<string, unknown>,
      signal,
      ctx,
    )
  }

  const accessToken = await requireXaiAccessToken(connection, credential)

  const model = resolveXaiModelId(canonicalNativeModelId(payload.model))
  const wsUrl = `${xaiWsBaseUrl(connection).replace(/\/+$/, "")}/responses`
  const chatBaseUrl = xaiChatBaseUrl(connection)
  const chatUrl = `${chatBaseUrl.replace(/\/+$/, "")}/responses`
  const useCliIdentity = isXaiCliChatProxyBaseUrl(chatBaseUrl)
  const clientStream = payload.stream === true
  const useUpstreamWs =
    !ctx?.forceUpstreamHttp
    && shouldUseUpstreamResponsesWebsocket(connection, "xai", ctx)
  const sessionId = resolveXaiSessionId(payload, model, ctx)
  const callerScope =
    ctx?.c ?
      resolveTranscriptScopeId(ctx.c)
    : (ctx?.transcriptScopeId ?? "anonymous")
  const replaySessionId =
    sessionId ?
      JSON.stringify([connection.id, credential.id, callerScope, sessionId])
    : undefined

  logCachePrefixDiag(sessionId, payload)

  const previousResponseIdRaw = (payload as { previous_response_id?: unknown })
    .previous_response_id
  const previousResponseId =
    typeof previousResponseIdRaw === "string" ?
      previousResponseIdRaw.trim() || undefined
    : undefined

  const baseBody: Record<string, unknown> = {
    ...payload,
    model,
    stream: true,
    previous_response_id: undefined,
    prompt_cache_retention: undefined,
    safety_identifier: undefined,
    stream_options: undefined,
  }
  if (sessionId && !baseBody.prompt_cache_key) {
    baseBody.prompt_cache_key = sessionId
  }

  const replayItems =
    replaySessionId && !previousResponseId ?
      await getReasoningReplayItems(model, replaySessionId)
    : undefined

  const sanitized = sanitizeXaiResponsesBodyWithRefs(baseBody, model)
  const upstreamBody = sanitized.body
  const namespaceToolRefs = sanitized.namespaceToolRefs
  const searchFilter = new XaiInternalXSearchResponseFilter(
    sanitized.hasNativeXSearch,
    sanitized.clientDeclaredTools,
  )

  const executionSessionId =
    ctx?.executionSessionId?.trim() || sessionId || connection.id
  const transcriptSessionId = JSON.stringify([callerScope, executionSessionId])
  const transcriptKey = xaiTranscriptKey(transcriptSessionId)
  const rawDelta =
    Array.isArray(payload.input) ? (payload.input as Array<unknown>) : []
  const cachedFull =
    previousResponseId ? getCodexTranscript(transcriptKey) : undefined
  const transcriptTrackable = !previousResponseId || Boolean(cachedFull)
  const fullInputThisTurn = buildResponsesTranscriptInput(
    cachedFull,
    rawDelta,
    Boolean(ctx?.downstreamWebsocket),
  )
  const fallbackFullInputBody =
    previousResponseId && cachedFull ?
      sanitizeXaiResponsesBodyWithRefs(
        {
          ...upstreamBody,
          input: pruneUnansweredToolCalls(fullInputThisTurn),
          previous_response_id: undefined,
        },
        model,
      ).body
    : undefined
  const httpFallbackBody = fallbackFullInputBody

  if (previousResponseId && !useUpstreamWs && !httpFallbackBody) {
    throw new HTTPError(
      "previous_response_not_found: chained xAI request requires full replay",
      new Response(null, { status: 409 }),
    )
  }

  if (useUpstreamWs) {
    const wsBody: Record<string, unknown> = {
      ...upstreamBody,
      previous_response_id: previousResponseId,
    }
    const wsTurn = await runXaiWebSocketTurn({
      connection,
      credential,
      accessToken,
      wsUrl,
      sessionId,
      replaySessionId,
      wsBody,
      executionSessionId,
      previousResponseId,
      fallbackFullInputBody,
      signal,
      ctx,
      model,
      namespaceToolRefs,
      searchFilter,
      fullInputThisTurn,
      transcriptKey,
      transcriptTrackable,
      clientStream,
    })
    if (wsTurn.handled) {
      return wsTurn.result
    }
  }

  let effectiveHttpBody = httpFallbackBody
  if (!effectiveHttpBody && replayItems && replayItems.length > 0) {
    effectiveHttpBody = sanitizeXaiResponsesBodyWithRefs(
      injectReasoningReplayItems({ ...upstreamBody }, replayItems),
      model,
    ).body
  }
  effectiveHttpBody ??= upstreamBody
  updateMemoryTrace(ctx?.memoryTraceId, "upstream_http_stringify_start", {
    provider: "xai",
    inputItems:
      Array.isArray(effectiveHttpBody.input) ?
        effectiveHttpBody.input.length
      : 0,
  })
  const httpBody = serializeUpstreamBody(effectiveHttpBody)
  updateMemoryTrace(ctx?.memoryTraceId, "upstream_http_send", {
    provider: "xai",
    wireBytes: Buffer.byteLength(httpBody),
  })

  let currentAccessToken = accessToken
  let response = await fetchWithConnectionProxy(connection, chatUrl, {
    method: "POST",
    headers: buildXaiHeaders(
      currentAccessToken,
      true,
      sessionId,
      useCliIdentity,
      connection.headers,
    ),
    body: httpBody,
    signal,
  })

  if (response.status === 403) {
    const errorBody = await response
      .clone()
      .text()
      .catch(() => "")
    if (
      /unauthenticated:bad-credentials|could not be validated/i.test(errorBody)
    ) {
      logger.warn(
        `xAI returned 403 bad-credentials for connection "${connection.name}". Forcing token refresh...`,
      )
      const refreshedToken = await ensureOAuthConnectionAccessToken(
        connection,
        credential,
        {
          forceRefresh: true,
          failedAccessToken: currentAccessToken,
        },
      )
      if (refreshedToken && refreshedToken !== currentAccessToken) {
        currentAccessToken = refreshedToken
        response = await fetchWithConnectionProxy(connection, chatUrl, {
          method: "POST",
          headers: buildXaiHeaders(
            currentAccessToken,
            true,
            sessionId,
            useCliIdentity,
            connection.headers,
          ),
          body: httpBody,
          signal,
        })
      }
    }
  }

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create xAI responses",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  if (clientStream) {
    const stream = await safeSseStream(response, detectResponsesStreamError)
    const normalized = normalizeResponsesStreamIds(
      normalizeXaiReasoningStream(stream),
    )
    const restored = restoreXaiNamespaceCallsInStream(
      normalized,
      namespaceToolRefs,
    )
    const filtered = filterXaiInternalSearchInStream(restored, searchFilter)
    if (ctx?.downstreamWebsocket && transcriptTrackable) {
      return recordXaiTranscript(
        filtered,
        transcriptKey,
        fullInputThisTurn,
        { model, sessionId: replaySessionId },
        ctx.memoryTraceId,
      )
    }
    return cacheXaiReasoningReplayInStream(filtered, model, replaySessionId)
  }

  const result = await collectResponsesFromSseResponse(response, model)
  for (const item of result.output ?? []) normalizeXaiReasoningItem(item)
  restoreXaiNamespaceToolCallsInResponse(result, namespaceToolRefs)
  searchFilter.filterResponse(result)
  if (replaySessionId) {
    void cacheReasoningReplayItems(
      model,
      replaySessionId,
      result as unknown as Record<string, unknown>,
    )
  }
  if (ctx?.downstreamWebsocket && transcriptTrackable) {
    recordTranscriptCheckpoint(
      ctx.memoryTraceId,
      appendCodexTranscript(
        transcriptKey,
        fullInputThisTurn,
        Array.isArray(result.output) ? result.output : [],
      ),
    )
  }
  return result
}

type XaiWsTurnOutcome =
  | {
      handled: true
      result: AsyncIterable<CopilotStreamEventLike> | ResponsesResponse
    }
  | { handled: false }

interface RunXaiWebSocketTurnOptions {
  connection: ProviderConnection
  credential: ApiCredential
  accessToken: string
  wsUrl: string
  sessionId?: string
  replaySessionId?: string
  wsBody: Record<string, unknown>
  executionSessionId: string
  previousResponseId?: string
  fallbackFullInputBody?: Record<string, unknown>
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  model: string
  namespaceToolRefs: Map<string, XaiNamespaceToolRef>
  searchFilter: XaiInternalXSearchResponseFilter
  fullInputThisTurn: Array<unknown>
  transcriptKey: string
  transcriptTrackable: boolean
  clientStream: boolean
}

async function runXaiWebSocketTurn(
  opts: RunXaiWebSocketTurnOptions,
): Promise<XaiWsTurnOutcome> {
  let wsToken = opts.accessToken
  const buildWsHeaders = () =>
    applyXaiWebsocketHeaders(
      buildXaiHeaders(
        wsToken,
        true,
        opts.sessionId,
        false,
        opts.connection.headers,
      ),
    )

  for (let wsAttempt = 0; wsAttempt < 2; wsAttempt++) {
    try {
      const wsStream = await openUpstreamResponsesWebsocketTurn({
        provider: "xai",
        accountId: opts.connection.id,
        httpResponsesUrl: opts.wsUrl,
        headers: buildWsHeaders(),
        body: opts.wsBody,
        executionSessionId: opts.executionSessionId,
        signal: opts.signal,
        previousResponseId: opts.previousResponseId,
        fallbackFullInputBody: opts.fallbackFullInputBody,
        memoryTraceId: opts.ctx?.memoryTraceId,
      })
      const normalized = normalizeResponsesStreamIds(
        normalizeXaiReasoningStream(wsStream),
      )
      const restored = restoreXaiNamespaceCallsInStream(
        normalized,
        opts.namespaceToolRefs,
      )
      const filtered = filterXaiInternalSearchInStream(
        restored,
        opts.searchFilter,
      )
      const tracked =
        opts.transcriptTrackable ?
          recordXaiTranscript(
            filtered,
            opts.transcriptKey,
            opts.fullInputThisTurn,
            { model: opts.model, sessionId: opts.replaySessionId },
            opts.ctx?.memoryTraceId,
          )
        : filtered
      if (opts.clientStream) {
        return { handled: true, result: tracked }
      }
      const collected = await collectResponsesFromEventStream(
        tracked,
        opts.model,
      )
      opts.searchFilter.filterResponse(collected)
      if (opts.replaySessionId) {
        void cacheReasoningReplayItems(
          opts.model,
          opts.replaySessionId,
          collected as unknown as Record<string, unknown>,
        )
      }
      return { handled: true, result: collected }
    } catch (error) {
      if (isAbortLikeError(error) || opts.signal?.aborted) throw error

      const refreshed = await maybeRefreshXaiWsToken(
        { connection: opts.connection, credential: opts.credential },
        opts.executionSessionId,
        wsAttempt,
        wsToken,
        error,
      )
      if (refreshed) {
        wsToken = refreshed
        continue
      }

      const failure = classifyWsFailure(error)
      if (
        failure.scope === "credential"
        || failure.scope === "request"
        || failure.scope === "local_saturation"
      ) {
        throw error
      }
      if (failure.kind === "connection_limit") {
        destroyUpstreamWebsocketSession(
          "xai",
          opts.connection.id,
          opts.executionSessionId,
        )
      }
      logger.warn(
        `xai websockets: falling back to HTTP: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return { handled: false }
    }
  }
  return { handled: false }
}

async function maybeRefreshXaiWsToken(
  subject: { connection: ProviderConnection; credential: ApiCredential },
  executionSessionId: string,
  wsAttempt: number,
  wsToken: string,
  error: unknown,
): Promise<string | undefined> {
  if (wsAttempt !== 0 || !isXaiBadCredentialsHttpError(error)) return undefined
  logger.warn(
    `xai websockets: bad-credentials for connection "${subject.connection.name}". `
      + "Forcing token refresh and retrying...",
  )
  const refreshedToken = await ensureOAuthConnectionAccessToken(
    subject.connection,
    subject.credential,
    {
      forceRefresh: true,
      failedAccessToken: wsToken,
    },
  )
  if (!refreshedToken || refreshedToken === wsToken) return undefined
  destroyUpstreamWebsocketSession(
    "xai",
    subject.connection.id,
    executionSessionId,
  )
  return refreshedToken
}
