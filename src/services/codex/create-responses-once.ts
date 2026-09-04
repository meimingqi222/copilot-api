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
import { canonicalNativeModelId } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import {
  getCredentialContextString,
  getConnectionSettings,
} from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { extractSessionIds, resolveStableSessionId } from "~/lib/routing"
import { sanitizeCodexInput } from "~/services/codex/sanitize-input"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import {
  collectResponsesFromEventStream,
  collectResponsesFromSseResponse,
} from "~/services/responses/sse-collector"
import {
  applyCodexWebsocketHeaders,
  destroyUpstreamWebsocketSession,
  isAbortLikeError,
  openUpstreamResponsesWebsocketTurn,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"
import { isChainedTurnUpstreamError } from "~/services/responses/upstream-ws-error"
import { classifyWsFailure } from "~/services/responses/ws-failure"

import { buildCodexHeaders } from "./headers"
import {
  assertChainedHttpReplayAvailable,
  buildCodexUpstreamBody,
  chainedHttpCodexRequestError,
  convertSystemRoleToDeveloper,
  isResponsesLiteRequest,
  stripReasoningItems,
} from "./upstream-body"
import {
  appendCodexTranscript,
  buildResponsesTranscriptInput,
  codexTranscriptKey,
  getCodexTranscript,
  resolveResponsesTranscriptSessionId,
  type TranscriptStoreResult,
} from "./ws-transcript-cache"

interface ResolvedCodexSessionHeaders {
  sessionId?: string
  threadId?: string
  /**
   * True when `sessionId` came from a client-supplied stable identifier
   * (`prompt_cache_key` or a `session_id`/`session-id` header) rather than the
   * turn-1 content-hash fallback (priority 3 below).
   *
   * This gates the transcript recovery cache (see ws-transcript-cache.ts):
   * the content-hash fallback is derived from the turn's own content, so two
   * *different* conversations that happen to open with an identical first
   * turn would hash to the same id and collide on the same transcript key —
   * an isolation break in a multi-user deployment, not just a cache-hit-rate
   * concern. Only an id the client actually chose is guaranteed unique to one
   * conversation.
   */
  sessionIdIsStable: boolean
}

/**
 * Resolves the session ID and thread ID for the upstream Codex request.
 *
 * Priority for session_id (used by the ChatGPT backend to group requests
 * within a session and reuse cached prompt prefixes):
 *   1. `prompt_cache_key` from the request body — this is the primary
 *      mechanism the official codex CLI uses (it sends prompt_cache_key in
 *      the body, and CPA/CLIProxyAPI mirrors it into the Session_id header).
 *   2. `session_id` / `session-id` from the forwarded incoming request header.
 *   3. Content-hash fallback via extractSessionIds + resolveStableSessionId
 *      (prefers turn-1 short hash so multi-turn Session_id stays stable).
 *
 * Priority for thread_id (sent as x-client-request-id):
 *   1. `thread_id` / `thread-id` from the forwarded incoming request header.
 *   2. Random UUID fallback (handled by header builder when omitted).
 */
function resolveCodexSessionHeaders(
  payload: ResponsesPayload,
  ctx?: RequestExecutionContext,
): ResolvedCodexSessionHeaders {
  const forwarded = ctx?.forwardedHeaders
  const threadIdRaw = forwarded?.["thread_id"] ?? forwarded?.["thread-id"]
  const threadId =
    typeof threadIdRaw === "string" && threadIdRaw.trim() ?
      threadIdRaw.trim()
    : undefined

  // 1. prompt_cache_key from body (highest priority — matches codex CLI + CPA)
  const bodyCacheKey = (payload as unknown as { prompt_cache_key?: unknown })
    .prompt_cache_key
  if (typeof bodyCacheKey === "string" && bodyCacheKey.trim()) {
    return {
      sessionId: bodyCacheKey.trim(),
      threadId,
      sessionIdIsStable: true,
    }
  }

  // 2. session_id from forwarded headers
  const headerSession = forwarded?.["session_id"] ?? forwarded?.["session-id"]
  if (typeof headerSession === "string" && headerSession.trim()) {
    return {
      sessionId: headerSession.trim(),
      threadId,
      sessionIdIsStable: true,
    }
  }

  // 3. L1 Codex content-hash fallback (stable Session_id across turns).
  //    Prefer short (turn-1) hash over full multi-turn hash so upstream
  //    cache is not broken when the client omits prompt_cache_key.
  //    Only used on the Codex path — never write this into Claude/AG.
  const extracted = extractSessionIds({
    headers: forwarded,
    payload,
  })
  const stableId = resolveStableSessionId(extracted)
  if (stableId) {
    return { sessionId: stableId, threadId, sessionIdIsStable: false }
  }

  return { threadId, sessionIdIsStable: false }
}

/**
 * Extracts extra codex-specific headers from the forwarded request headers.
 * The official codex CLI sends these and the ChatGPT backend uses them for
 * cache routing and turn metadata. Mirrors CLIProxyAPI's EnsureHeader pattern.
 */
function resolveCodexExtraHeaders(
  ctx?: RequestExecutionContext,
): Record<string, string> {
  const forwarded = ctx?.forwardedHeaders
  if (!forwarded) {
    return {}
  }
  const extra: Record<string, string> = {}
  for (const key of [
    "x-codex-turn-metadata",
    "x-codex-window-id",
    "x-codex-beta-features",
    "version",
    "originator",
    // Responses Lite marker. When present, upstream requires
    // parallel_tool_calls to be false (see isResponsesLiteRequest).
    "x-openai-internal-codex-responses-lite",
  ]) {
    const value = forwarded[key]
    if (typeof value === "string" && value.trim()) {
      extra[key] = value.trim()
    }
  }
  return extra
}

/** Transport a finalized Codex body is about to be sent over. */
type CodexOutboundTransport = "http" | "ws"

/**
 * Single normalization boundary every body sent to the Codex upstream must
 * pass through last, regardless of which path assembled it (the primary
 * request, the WS `previous_response_id` turn, or a transcript-replay
 * rebuild). Before this existed, `input`-level normalization was applied at
 * `buildCodexUpstreamBody` time and the replay path (which rebuilds `input`
 * from the raw client delta + transcript, bypassing that) had to remember to
 * re-apply it separately — exactly the bug fixed above at the `input:`
 * assignment in the replay body (a replayed turn sent role "system" upstream
 * and was rejected with "Codex API does not accept 'system' role in the
 * input array"). Centralizing here means a future input-level transform only
 * has to be added in one place.
 */
export function finalizeCodexOutboundBody(
  body: Record<string, unknown>,
  transport: CodexOutboundTransport,
): Record<string, unknown> {
  const finalized: Record<string, unknown> = {
    ...body,
    input: convertSystemRoleToDeveloper(body.input),
  }
  if (transport === "http") {
    // `generate` is WebSocket-only (CPA deletes it on the HTTP path): a
    // spawn-agent turn over plain HTTP would be rejected/orphaned upstream.
    finalized.generate = undefined
    // The codex HTTP backend rejects stream_options.include_usage (CPA
    // drops the whole stream_options there, keeping only
    // reasoning_summary_delivery). include_usage is WS-only. Copy before
    // deleting: `stream_options` may be a shared reference with the WS body.
    const streamOptions = finalized.stream_options as
      | Record<string, unknown>
      | undefined
    if (streamOptions && typeof streamOptions === "object") {
      const httpStreamOptions = { ...streamOptions }
      delete httpStreamOptions.include_usage
      finalized.stream_options =
        Object.keys(httpStreamOptions).length === 0 ?
          undefined
        : httpStreamOptions
    }
  }
  return sanitizeCodexInput(finalized)
}

export async function createCodexResponsesOnce(
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

  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `Codex access token missing for connection "${connection.name}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  const memoryTraceId = readMemoryTraceId(ctx)
  const settingsBase = getConnectionSettings(connection)?.baseUrl
  const baseUrl = (
    typeof settingsBase === "string" ? settingsBase : (
      CODEX_API_BASE_URL
    )).replace(/\/+$/, "")
  const url = `${baseUrl}/responses`
  const clientStream = payload.stream === true
  const useUpstreamWs =
    !ctx?.forceUpstreamHttp
    && shouldUseUpstreamResponsesWebsocket(connection, "codex", ctx)
  const { sessionId, threadId, sessionIdIsStable } = resolveCodexSessionHeaders(
    payload,
    ctx,
  )
  const extraHeaders = resolveCodexExtraHeaders(ctx)
  const responsesLite = isResponsesLiteRequest(payload, ctx)

  // previous_response_id is WS-only (CPA). HTTP body always strips it.
  const previousResponseIdRaw = (payload as { previous_response_id?: unknown })
    .previous_response_id
  const previousResponseId =
    typeof previousResponseIdRaw === "string" ?
      previousResponseIdRaw.trim() || undefined
    : undefined

  const upstreamBody = buildCodexUpstreamBody(payload, model, responsesLite)

  // ── Reasoning Replay Cache ───────────────────────────────────────────
  // Resolve the replay session key BEFORE identity confuse remaps
  // prompt_cache_key. The replay cache must be independent from the
  // selected credential so auth failover can preserve replay (CPA design).
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

  // ── Identity Confuse ────────────────────────────────────────────────
  // Remap prompt_cache_key to a per-account deterministic UUID so that
  // multi-account load balancing doesn't break cache affinity.
  const identityState = applyIdentityConfuseBody(
    connection.id,
    payload as unknown as Record<string, unknown>,
    upstreamBody,
  )

  // Inject cached reasoning items from previous turns in this session.
  if (scopedReplaySessionKey) {
    const replayItems = await getReasoningReplayItems(
      model,
      scopedReplaySessionKey,
    )
    if (replayItems && replayItems.length > 0) {
      injectReasoningReplayItems(upstreamBody, replayItems)
    }
  }

  // Debug: surface the reasoning-related fields we actually send upstream,
  // to diagnose cases where the client never sees thinking/reasoning output.
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

  // ── Build headers (HTTP-safe base; WS path clones + rewrites) ────────
  const httpHeaders: Record<string, string> = {
    ...buildCodexHeaders(accessToken, true, {
      sessionId,
      threadId,
      accountId: getCredentialContextString(connection, "oauthAccountId"),
    }),
    ...extraHeaders,
  }
  // Apply identity confuse to headers (remaps Session_id, turn metadata, etc.)
  applyIdentityConfuseHeaders(httpHeaders, identityState)

  // ── Upstream WebSocket path (CPA CodexWebsocketsExecutor) ────────────
  // Set when a chained turn falls back to HTTP: the HTTP POST must send the
  // full self-contained input (not the client's delta), or a tool-result turn
  // arrives as an orphan custom_tool_call_output and upstream rejects it with
  // "No tool call found for custom tool call output with call_id ...".
  const executionSessionId =
    ctx?.executionSessionId?.trim()
    || sessionId
    || replaySessionKey
    || connection.id
  // Transcript recovery is gated on a client-supplied stable session id —
  // never the turn-1 content-hash fallback (two different conversations that
  // open with an identical first turn would hash to the same id and collide
  // on the same transcript, leaking one tenant's turns into another's replay)
  // and never `account.id` (shared by every caller routed to this credential).
  // `transcriptKey` is therefore only ever built from `sessionId` once we know
  // it is stable, so `resolveResponsesTranscriptSessionId`'s empty-preferred
  // fallback (which would key on `executionSessionId`, bottoming out at
  // `account.id`) is never reached for a key that is actually read or
  // written — making an account-scoped transcript key structurally
  // impossible rather than merely coincidentally absent.
  //
  // A tenant scope is equally required, and for the same reason: a stable
  // session id is only unique *within* a principal. Not every entry point
  // establishes one — the chat→responses bridge (`dispatch/shared.ts`
  // responsesExecutor, whose executionContext is built in
  // `routes/chat-completions/handler.ts`) forwards `session_id` /
  // `prompt_cache_key` but no `transcriptScopeId` — so without this guard two
  // principals sending the same id would share one transcript entry and
  // replay each other's turns. Fail closed: no scope means no transcript, and
  // a chained turn degrades to the documented 409 instead. Any future entry
  // point that forgets to pass a scope loses recovery rather than isolation.
  const transcriptKey =
    transcriptScopeId && sessionIdIsStable && sessionId ?
      codexTranscriptKey(
        resolveResponsesTranscriptSessionId(
          executionSessionId,
          sessionId,
          transcriptScopeId,
        ),
      )
    : undefined
  // Use the *raw* client input delta (not upstreamBody.input, which may have
  // reasoning-replay items injected) so full replay never double-injects it.
  const rawDelta =
    Array.isArray(payload.input) ? (payload.input as Array<unknown>) : []
  // Apply the same gate to reads as to writes: a transcript keyed on an
  // unstable/account-scoped id could never legitimately have been written
  // under the rules above, so it must never be consulted either.
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
  const fallbackFullInputBody =
    previousResponseId && cachedFull ?
      {
        ...upstreamBody,
        // The replay input is rebuilt from the *raw* client delta + transcript,
        // so it bypasses `buildCodexUpstreamBody`'s per-field normalization.
        // `input` itself is normalized once, at send time, by
        // `finalizeCodexOutboundBody` (see below) — not here — so this stays
        // in sync with the primary body's normalization automatically.
        input: stripReasoningItems(fullInputThisTurn),
        previous_response_id: undefined,
      }
    : undefined
  const httpFallbackBody = fallbackFullInputBody

  // A forced HTTP retry can recover a chained turn only when the socket-scoped
  // delta can be expanded from the transcript cache.
  assertChainedHttpReplayAvailable(
    previousResponseId,
    useUpstreamWs,
    httpFallbackBody,
    memoryTraceId,
  )

  // Upstream WebSocket attempt. Returns the completed turn when the WS path
  // succeeds, or undefined when the socket is unusable and the caller should
  // fall through to a same-account HTTP POST.
  if (useUpstreamWs) {
    const wsTurn = await attemptCodexUpstreamWsTurn({
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
    })
    if (wsTurn !== undefined) {
      return wsTurn
    }
  }

  const response = await postCodexResponses({
    connection,
    url,
    headers: httpHeaders,
    upstreamBody,
    httpFallbackBody,
    signal,
    memoryTraceId,
  })

  if (!response.ok) {
    // Clear reasoning replay cache on thinking_signature_invalid errors.
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
    // Gate on a client-supplied stable session id (transcriptKey), not on
    // transport: an HTTP-only client with a stable prompt_cache_key is just
    // as entitled to recovery as a WebSocket client (P1 — previously this
    // required ctx.downstreamWebsocket, so pure-HTTP chained clients like
    // Crush always hit the 409 path even when they supplied a stable id).
    const tracked =
      transcriptKey && transcriptTrackable ?
        recordCodexTranscript(
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
  // Debug: same reasoning-summary check as the streaming path, for the
  // non-streaming (clientStream=false) response.
  logCodexReasoningSummary(
    "[codex] non-stream response reasoning summary",
    result.output as Array<Record<string, unknown>> | undefined,
  )
  // Cache reasoning items from the completed response.
  // `result` is the response object itself (has `output`), so we pass it
  // directly — cacheReasoningReplayItems checks both `.response.output`
  // (SSE event shape) and `.output` (collected response shape).
  if (scopedReplaySessionKey) {
    void cacheReasoningReplayItems(
      model,
      scopedReplaySessionKey,
      result as unknown as Record<string, unknown>,
    )
  }
  // Restore original identifiers in the response.
  if (identityState.enabled) {
    const restored = restoreIdentityConfuseResponse(
      JSON.stringify(result),
      identityState,
    )
    return JSON.parse(restored) as ResponsesResponse
  }
  return result
}

/**
 * Passthrough generator that, on each successful terminal response, appends the
 * completed response's output items to the running full-input transcript and
 * stores it. This lets a later turn that lands on a fresh upstream socket
 * replay a self-contained request (full input, no previous_response_id)
 * instead of failing with "Previous response with id ... not found.".
 *
 * Runs on the *normalized* stream so recorded output-item ids match what the
 * codex client sees (and later chains from).
 */
async function* recordCodexTranscript(
  stream: AsyncIterable<CopilotStreamEventLike>,
  transcriptKey: string,
  fullInputThisTurn: Array<unknown>,
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
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (
          parsed.type === "response.completed"
          || parsed.type === "response.incomplete"
        ) {
          const response = parsed.response as { output?: unknown } | undefined
          const output: Array<unknown> =
            response && Array.isArray(response.output) ?
              (response.output as Array<unknown>)
            : []
          recordTranscriptCheckpoint(
            memoryTraceId,
            appendCodexTranscript(transcriptKey, fullInputThisTurn, output),
          )
        }
      } catch {
        // Best-effort transcript recording.
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

function countArrayItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function readMemoryTraceId(
  ctx: RequestExecutionContext | undefined,
): string | undefined {
  return ctx?.memoryTraceId
}

async function postCodexResponses(options: {
  connection: ProviderConnection
  url: string
  headers: Record<string, string>
  upstreamBody: Record<string, unknown>
  httpFallbackBody?: Record<string, unknown>
  signal?: AbortSignal
  memoryTraceId?: string
}): Promise<Response> {
  const effectiveBody = finalizeCodexOutboundBody(
    options.httpFallbackBody ?? options.upstreamBody,
    "http",
  )
  updateMemoryTrace(options.memoryTraceId, "upstream_http_stringify_start", {
    provider: "codex",
    inputItems: countArrayItems(effectiveBody.input),
  })
  const body = JSON.stringify(effectiveBody)
  updateMemoryTrace(options.memoryTraceId, "upstream_http_send", {
    provider: "codex",
    wireBytes: Buffer.byteLength(body),
  })
  return fetchWithConnectionProxy(options.connection, options.url, {
    method: "POST",
    headers: options.headers,
    // HTTP never sends previous_response_id. A chained WS fallback uses the
    // full self-contained body so the tool-result turn is not orphaned.
    body,
    signal: options.signal,
  })
}

/**
 * Wraps a Codex SSE stream to:
 * 1. Cache reasoning items from `response.completed` events.
 * 2. Restore original identifiers (identity confuse) in all events.
 */
/**
 * Debug: confirm whether a completed Codex response actually contains
 * reasoning output items (and a non-empty summary) before it's forwarded to
 * the client. Helps diagnose cases where thinking output silently vanishes.
 */
function logCodexReasoningSummary(
  label: string,
  output: Array<Record<string, unknown>> | undefined,
): void {
  const reasoningItems = output?.filter((item) => item.type === "reasoning")
  logger.debug(label, {
    outputTypes: output?.map((item) => item.type),
    reasoningItemCount: reasoningItems?.length ?? 0,
    reasoningHasSummary: reasoningItems?.some(
      (item) => Array.isArray(item.summary) && item.summary.length > 0,
    ),
  })
}

/** Handles a successful terminal SSE frame: cache + debug-log. */
function handleCodexStreamCompletion(
  parsed: Record<string, unknown>,
  model: string,
  replaySessionKey: string | undefined,
): void {
  if (
    parsed.type !== "response.completed"
    && parsed.type !== "response.incomplete"
  ) {
    return
  }
  if (replaySessionKey) {
    void cacheReasoningReplayItems(model, replaySessionKey, parsed)
  }
  const output = (
    parsed.response as { output?: Array<Record<string, unknown>> }
  ).output
  logCodexReasoningSummary(`[codex] ${parsed.type} reasoning summary`, output)
}

async function* wrapCodexStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  model: string,
  replaySessionKey: string | undefined,
  identityState: IdentityConfuseState,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    let data = event.data
    if (!data || data === "[DONE]") {
      yield event
      continue
    }

    // Cache reasoning items on successful terminal response events.
    if (
      data.includes('"response.completed"')
      || data.includes('"response.incomplete"')
    ) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        handleCodexStreamCompletion(parsed, model, replaySessionKey)
      } catch {
        // Best-effort caching.
      }
    }

    // Restore original identifiers.
    if (identityState.enabled) {
      data = restoreIdentityConfuseResponse(data, identityState)
    }

    yield { ...event, data }
  }
}

interface CodexWsTurnOptions {
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
}

/**
 * Run one Codex turn over the upstream WebSocket. Returns the completed turn
 * (stream or collected response) on success, or undefined when the socket is
 * unusable and the caller should fall through to a same-account HTTP POST.
 */
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
  } = options
  const wsBody = finalizeCodexOutboundBody(
    { ...upstreamBody, previous_response_id: previousResponseId },
    "ws",
  )
  // `generate` must survive on the WS transport (see finalizeCodexOutboundBody);
  // finalize the replay fallback the same way so a fresh-socket recovery turn
  // does not silently drop it either.
  const wsFallbackFullInputBody =
    fallbackFullInputBody
    && finalizeCodexOutboundBody(fallbackFullInputBody, "ws")
  const wsHeaders = applyCodexWebsocketHeaders({ ...httpHeaders })
  try {
    // Eager open+send so handshake failures hit this catch (streaming-safe).
    const wsStream = await openUpstreamResponsesWebsocketTurn({
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
    // Record on the normalized stream so recorded output-item ids match what
    // the codex client sees (and later chains from). Gated the same as the
    // HTTP paths below: a client-supplied stable session id, not merely
    // "this transport is a WebSocket".
    const tracked =
      transcriptKey && transcriptTrackable ?
        recordCodexTranscript(
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
      // wrapCodexStream restores confused identifiers before collection, so
      // the returned object must not be restored a second time.
      wrapCodexStream(tracked, model, scopedReplaySessionKey, identityState),
      model,
    )
  } catch (error) {
    if (isAbortLikeError(error) || signal?.aborted) throw error
    const failure = classifyWsFailure(error)
    // A chained turn the upstream rejected because its server-side chain is
    // gone (account switch / fresh socket with no transcript to replay):
    // signal the client to resend the full conversation. Codex CLI/Desktop
    // and waku recognize `previous_response_not_found` and retry with a
    // self-contained replay. The in-turn auto-retry (upstream-ws.ts) already
    // exhausted the transcript path before this error surfaced.
    if (isChainedTurnUpstreamError(error) && previousResponseId) {
      throw chainedHttpCodexRequestError()
    }
    // credential (quota/auth/rate/server) and request (bad body) failures are
    // the handler's concern — an account switch or a surfaced error. Never
    // silently re-POST them on the same account.
    if (failure.scope === "credential" || failure.scope === "request") {
      throw error
    }
    // connection scope: this socket is unusable. On a connection-limit frame,
    // destroy the stale session so the next turn redials; then fall through
    // to a same-account HTTP POST for the current turn.
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
