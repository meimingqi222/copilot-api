import { createHash } from "node:crypto"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import {
  cacheReasoningReplayItems,
  getReasoningReplayItems,
  injectReasoningReplayItems,
} from "~/lib/cache/reasoning-replay-cache"
import { HTTPError } from "~/lib/error"
import { canonicalNativeModelId } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
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
  applyXaiWebsocketHeaders,
  destroyUpstreamWebsocketSession,
  isAbortLikeError,
  openUpstreamResponsesWebsocketTurn,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"
import { classifyWsFailure } from "~/services/responses/ws-failure"

import {
  appendResponsesTranscript,
  buildResponsesTranscriptInput,
  getResponsesTranscript,
  resolveSocketResponsesTranscriptSessionId,
  type TranscriptStoreResult,
  xaiTranscriptKey,
} from "../codex/ws-transcript-cache"
import {
  isXaiCliChatProxyBaseUrl,
  xaiChatBaseUrl,
  xaiWsBaseUrl,
} from "./endpoint"
import { buildXaiHeaders } from "./headers"
import {
  restoreXaiNamespaceToolCalls,
  sanitizeXaiResponsesBodyWithRefs,
  type XaiNamespaceToolRef,
} from "./sanitize-body"
import { XaiInternalXSearchResponseFilter } from "./search-filter"
import { resolveXaiSessionId } from "./session"

/**
 * Computes a short hash of a string for cache-prefix diagnostics.
 * Returns the first 12 hex chars of a sha256, enough to spot changes.
 */
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12)
}

/**
 * True when an upstream error indicates an invalidated xAI OAuth access token:
 * an HTTP 403 carrying the bad-credentials payload. Mirrors CPA
 * `isXAIBadCredentialsBody`. Used to decide whether to force a token refresh
 * and retry once instead of treating the account as an unrecoverable auth error.
 */
function isXaiBadCredentialsHttpError(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return false
  if (error.response.status !== 403) return false
  const body = `${error.responseBody} ${error.message}`
  return /unauthenticated:bad-credentials|could not be validated/i.test(body)
}

/**
 * Logs a cache-prefix diagnostic for xAI Responses requests. By comparing
 * the instructions hash, tools hash, and input-prefix hash across requests
 * within the same session (prompt_cache_key), you can identify which
 * component is breaking the cache prefix.
 *
 * Format:
 *   [xAI cache-diag] session=xxx instr=abc12345(8192) tools=def67890(4096)
 *   input_prefix=ghi13579 types=[user,reasoning,function_call,...] input_count=15
 *
 * If `instr` or `tools` hash changes between turns of the same session,
 * the system prompt or tool definitions are not stable — this is the
 * primary cause of cache misses.
 */
function logCachePrefixDiag(
  sessionId: string | undefined,
  payload: ResponsesPayload,
): void {
  const instructions = payload.instructions ?? ""
  const instrHash = instructions ? shortHash(instructions) : "(none)"
  const instrLen = instructions.length

  const toolsJson = payload.tools ? JSON.stringify(payload.tools) : ""
  const toolsHash = toolsJson ? shortHash(toolsJson) : "(none)"
  const toolsLen = toolsJson.length

  // Summarize the input array: item types and a hash of the first ~2KB
  // of the serialized input (the prefix that should be cached).
  let inputCount = 0
  let inputTypes: Array<string> = []
  let inputPrefixHash = "(none)"
  if (typeof payload.input === "string") {
    inputCount = 1
    inputTypes = ["string"]
    inputPrefixHash = shortHash(payload.input.slice(0, 2048))
  } else if (Array.isArray(payload.input)) {
    inputCount = payload.input.length
    inputTypes = payload.input.slice(0, 20).map((item) => {
      if (typeof item === "string") return "string"
      if ("type" in item) return item.type
      if ("role" in item) return item.role
      return "unknown"
    })
    // Hash the serialized first 4KB of the input array for prefix comparison.
    const inputPrefix = JSON.stringify(payload.input.slice(0, 10)).slice(
      0,
      4096,
    )
    inputPrefixHash = shortHash(inputPrefix)
  }

  logger.debug(
    `[xAI cache-diag] session=${sessionId ?? "(none)"} `
      + `instr=${instrHash}(${instrLen}) tools=${toolsHash}(${toolsLen}) `
      + `input_prefix=${inputPrefixHash} `
      + `types=[${inputTypes.join(",")}] input_count=${inputCount}`,
  )
}

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

  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `xAI access token missing for connection "${connection.name}"`,
    )
  }

  const model = resolveXaiModelId(canonicalNativeModelId(payload.model))
  // WebSocket always uses the official API (cli-chat-proxy rejects WS with 405).
  // HTTP chat uses the resolved chat endpoint: Grok CLI chat-proxy in CLI mode
  // (the default) or the official API when settings.useApi is true.
  const wsUrl = `${xaiWsBaseUrl(connection).replace(/\/+$/, "")}/responses`
  const chatBaseUrl = xaiChatBaseUrl(connection)
  const chatUrl = `${chatBaseUrl.replace(/\/+$/, "")}/responses`
  const useCliIdentity = isXaiCliChatProxyBaseUrl(chatBaseUrl)
  const clientStream = payload.stream === true
  const useUpstreamWs =
    !ctx?.forceUpstreamHttp
    && shouldUseUpstreamResponsesWebsocket(connection, "xai", ctx)
  const sessionId = resolveXaiSessionId(payload, model, ctx)

  // Log cache-prefix diagnostic so we can compare prefix stability across
  // turns within the same session. If instr/tools hash changes between
  // requests with the same session ID, the cache prefix is broken.
  logCachePrefixDiag(sessionId, payload)

  // previous_response_id is WS-only (xAI WS Mode + CPA). HTTP strips it.
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
  // Ensure prompt_cache_key is set in the body when we have a session ID,
  // matching CPA's behavior of mirroring the session ID into the body.
  if (sessionId && !baseBody.prompt_cache_key) {
    baseBody.prompt_cache_key = sessionId
  }

  // Fetch cached reasoning items for replay. xAI WebSocket sessions keep
  // multi-turn continuity server-side (previous_response_id / x-grok-conv-id),
  // so replay is injected only into HTTP requests, mirroring CPA. Reading the
  // cache here lets the HTTP path below reuse the result.
  const replayItems =
    sessionId && !previousResponseId ?
      await getReasoningReplayItems(model, sessionId)
    : undefined

  const sanitized = sanitizeXaiResponsesBodyWithRefs(baseBody, model)
  const upstreamBody = sanitized.body
  const namespaceToolRefs = sanitized.namespaceToolRefs
  const searchFilter = new XaiInternalXSearchResponseFilter(
    sanitized.hasNativeXSearch,
    sanitized.clientDeclaredTools,
  )

  // ── Upstream WebSocket path (CPA XAIWebsocketsExecutor) ──────────────
  // Set when a chained turn falls back to HTTP: the HTTP POST must send the
  // full self-contained input (not the client's delta) so the tool-result turn
  // is not an orphan.
  const executionSessionId =
    ctx?.executionSessionId?.trim() || sessionId || connection.id
  const transcriptSessionId = resolveSocketResponsesTranscriptSessionId(
    executionSessionId,
    sessionId,
    ctx?.transcriptScopeId,
  )
  const transcriptKey = xaiTranscriptKey(transcriptSessionId)
  const rawDelta =
    Array.isArray(payload.input) ? (payload.input as Array<unknown>) : []
  const cachedFull =
    previousResponseId ? getResponsesTranscript(transcriptKey) : undefined
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
          input: fullInputThisTurn,
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
  // Inject the previous turn's encrypted reasoning only into plain HTTP
  // requests (WS keeps continuity server-side). On a chained-turn WS fallback
  // the full-input replay already carries the reasoning, so skip it there.
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
  const httpBody = JSON.stringify(effectiveHttpBody)
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
    ),
    // HTTP: no previous_response_id. On a chained-turn WS fallback, send the
    // full self-contained input (httpFallbackBody) so the turn is not orphaned.
    body: httpBody,
    signal,
  })

  // Handle xAI 403 bad-credentials (OAuth token expired on server) -> auto-refresh and retry once
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
      stream as unknown as AsyncIterable<CopilotStreamEventLike>,
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
        { model, sessionId },
        ctx.memoryTraceId,
      )
    }
    // Plain HTTP streaming has no transcript to piggyback on — cache the
    // reasoning so a subsequent HTTP turn in this session can replay it.
    return cacheXaiReasoningReplayInStream(filtered, model, sessionId)
  }

  const result = await collectResponsesFromSseResponse(response, model)
  restoreXaiNamespaceToolCallsInResponse(result, namespaceToolRefs)
  searchFilter.filterResponse(result)
  if (sessionId) {
    void cacheReasoningReplayItems(
      model,
      sessionId,
      result as unknown as Record<string, unknown>,
    )
  }
  if (ctx?.downstreamWebsocket && transcriptTrackable) {
    recordTranscriptCheckpoint(
      ctx.memoryTraceId,
      appendResponsesTranscript(
        transcriptKey,
        fullInputThisTurn,
        Array.isArray(result.output) ? result.output : [],
      ),
    )
  }
  return result
}

/** Reasoning-replay context threaded through the transcript/HTTP stream paths. */
interface XaiReasoningReplayContext {
  model?: string
  sessionId?: string
}

/** Outcome of an upstream WebSocket turn: handled (return the result) or fell
 * back to HTTP. */
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

/**
 * Runs one xAI upstream WebSocket turn with up to two attempts. The first
 * attempt's failure on a 403 bad-credentials frame forces an OAuth refresh and
 * retries once on a fresh socket; connection-scope failures fall back to HTTP
 * (handled=false); credential/request failures rethrow.
 */
async function runXaiWebSocketTurn(
  opts: RunXaiWebSocketTurnOptions,
): Promise<XaiWsTurnOutcome> {
  let wsToken = opts.accessToken
  const buildWsHeaders = () =>
    applyXaiWebsocketHeaders(buildXaiHeaders(wsToken, true, opts.sessionId))

  for (let wsAttempt = 0; wsAttempt < 2; wsAttempt++) {
    try {
      // Eager open+send so handshake failures hit this catch (streaming-safe).
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
      const normalized = normalizeResponsesStreamIds(wsStream)
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
            { model: opts.model, sessionId: opts.sessionId },
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
      if (opts.sessionId) {
        void cacheReasoningReplayItems(
          opts.model,
          opts.sessionId,
          collected as unknown as Record<string, unknown>,
        )
      }
      return { handled: true, result: collected }
    } catch (error) {
      if (isAbortLikeError(error) || opts.signal?.aborted) throw error

      // xAI 403 bad-credentials → force OAuth refresh and retry once.
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
      // credential (quota/auth/rate/server) and request (bad body) failures are
      // the caller's concern — an account switch or a surfaced error. Never
      // silently re-POST them on the same account.
      if (failure.scope === "credential" || failure.scope === "request") {
        throw error
      }
      // connection scope: this socket is unusable. On a connection-limit frame,
      // destroy the stale session so the next turn redials; then fall through
      // to a same-account HTTP POST for the current turn.
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

/**
 * On a 403 bad-credentials frame, refresh the xAI OAuth token and return it.
 * Returns undefined when the error is not bad-credentials, the attempt already
 * refreshed once, or the refresh did not produce a new token.
 */
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

/**
 * Passthrough generator that, on each successful terminal response, appends the
 * completed response's output items to the running full-input transcript and
 * stores it. Also caches reasoning items for the session.
 */
async function* recordXaiTranscript(
  stream: AsyncIterable<CopilotStreamEventLike>,
  transcriptKey: string,
  fullInputThisTurn: Array<unknown>,
  replay: XaiReasoningReplayContext,
  memoryTraceId?: string,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    const data = event.data
    if (
      data
      && data !== "[DONE]"
      && (data.includes('"response.completed"')
        || data.includes('"response.incomplete"'))
    ) {
      recordXaiTerminalEvent(
        data,
        replay,
        transcriptKey,
        fullInputThisTurn,
        memoryTraceId,
      )
    }
    yield event
  }
}

/** Extract transcript + reasoning-replay cache from a terminal response frame. */
function recordXaiTerminalEvent(
  data: string,
  replay: XaiReasoningReplayContext,
  transcriptKey: string,
  fullInputThisTurn: Array<unknown>,
  memoryTraceId?: string,
): void {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    if (
      parsed.type !== "response.completed"
      && parsed.type !== "response.incomplete"
    ) {
      return
    }
    const response = parsed.response as { output?: unknown } | undefined
    const output: Array<unknown> =
      response && Array.isArray(response.output) ?
        (response.output as Array<unknown>)
      : []
    recordTranscriptCheckpoint(
      memoryTraceId,
      appendResponsesTranscript(transcriptKey, fullInputThisTurn, output),
    )
    if (
      replay.model
      && replay.sessionId
      && parsed.type === "response.completed"
    ) {
      void cacheReasoningReplayItems(replay.model, replay.sessionId, parsed)
    }
  } catch {
    // Best-effort transcript recording.
  }
}

/**
 * Passthrough generator that filters out internal x_search subtool traces
 * (xs_call...) from every upstream SSE data payload.
 */
async function* filterXaiInternalSearchInStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  searchFilter: XaiInternalXSearchResponseFilter,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    if (event.data && event.data !== "[DONE]") {
      const filteredData = searchFilter.apply(event.data)
      if (filteredData === null) {
        continue
      }
      yield filteredData === event.data ?
        event
      : { ...event, data: filteredData }
    } else {
      yield event
    }
  }
}

/**
 * Passthrough generator that caches reasoning items on `response.completed`
 * for the plain HTTP-streaming path (which has no transcript to piggyback on),
 * so a subsequent HTTP turn in the same session can replay them.
 */
async function* cacheXaiReasoningReplayInStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  model?: string,
  sessionId?: string,
): AsyncIterable<CopilotStreamEventLike> {
  if (!model || !sessionId) {
    yield* stream
    return
  }
  for await (const event of stream) {
    const data = event.data
    if (data && data !== "[DONE]" && data.includes('"response.completed"')) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (parsed.type === "response.completed") {
          void cacheReasoningReplayItems(model, sessionId, parsed)
        }
      } catch {
        // Best-effort reasoning replay caching.
      }
    }
    yield event
  }
}

function recordTranscriptCheckpoint(
  memoryTraceId: string | undefined,
  result: TranscriptStoreResult,
): void {
  updateMemoryTrace(
    memoryTraceId,
    result.stored ? "transcript_stored" : "transcript_dropped",
    {
      transcriptEntryBytes: result.entryBytes,
      transcriptTotalBytes: result.totalBytes,
      transcriptEntries: result.entries,
    },
  )
}

/**
 * Passthrough generator that restores namespace-qualified function_call names
 * in every upstream SSE data payload before it reaches the client or the
 * transcript recorder. Mirrors CPA's restore on HTTP SSE and WS frames.
 */
async function* restoreXaiNamespaceCallsInStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  refs: Map<string, XaiNamespaceToolRef>,
): AsyncIterable<CopilotStreamEventLike> {
  if (refs.size === 0) {
    yield* stream
    return
  }
  for await (const event of stream) {
    if (event.data && event.data !== "[DONE]") {
      const restored = restoreXaiNamespaceToolCalls(event.data, refs)
      yield restored === event.data ? event : { ...event, data: restored }
    } else {
      yield event
    }
  }
}

/** Restore namespace-qualified function_call names in a completed response. */
function restoreXaiNamespaceToolCallsInResponse(
  response: ResponsesResponse,
  refs: Map<string, XaiNamespaceToolRef>,
): void {
  if (refs.size === 0 || !Array.isArray(response.output)) return
  for (const item of response.output) {
    if (typeof item !== "object") continue
    const record = item as unknown as Record<string, unknown>
    if (record.type !== "function_call") continue
    const qualified = typeof record.name === "string" ? record.name.trim() : ""
    const ref = refs.get(qualified)
    if (!ref) continue
    record.name = ref.name
    record.namespace = ref.namespace
  }
}
