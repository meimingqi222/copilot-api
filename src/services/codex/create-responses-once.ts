import type { Account } from "~/lib/accounts"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { canonicalNativeModelId, isOAuthAccount } from "~/lib/accounts"
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
import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { extractSessionIds, resolveStableSessionId } from "~/lib/routing"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { withDefaultReasoningSummary } from "~/services/copilot/responses-api"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { collectResponsesFromSseResponse } from "~/services/responses/sse-collector"
import {
  applyCodexWebsocketHeaders,
  destroyUpstreamWebsocketSession,
  isAbortLikeError,
  openUpstreamResponsesWebsocketTurn,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"
import { classifyWsFailure } from "~/services/responses/ws-failure"

import { buildCodexHeaders } from "./headers"
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

/**
 * Detects whether the incoming request targets OpenAI's "Responses Lite"
 * variant. The official codex CLI signals this two ways:
 *   - HTTP transport: the `x-openai-internal-codex-responses-lite: true`
 *     request header (added by `add_responses_lite_header`).
 *   - WebSocket transport: a `client_metadata` entry keyed
 *     `ws_request_header_x_openai_internal_codex_responses_lite` = "true"
 *     (added by `build_ws_client_metadata`), which the upstream proxy
 *     converts back into the header.
 *
 * When Responses Lite is active, the codex client forces
 * `parallel_tool_calls` to false and the ChatGPT backend rejects any request
 * that sends the marker together with `parallel_tool_calls: true`
 * ("X-OpenAI-Internal-Codex-Responses-Lite requires `parallel_tool_calls` to
 * be false."). We must mirror that invariant when proxying.
 */
function isResponsesLiteRequest(
  payload: ResponsesPayload,
  ctx?: RequestExecutionContext,
): boolean {
  // 1. Forwarded HTTP header from the codex client.
  const headerValue =
    ctx?.forwardedHeaders?.["x-openai-internal-codex-responses-lite"]
  if (isResponsesLiteMarker(headerValue)) {
    return true
  }

  // 2. WebSocket transport marker carried inside client_metadata.
  const clientMetadata = (payload as { client_metadata?: unknown })
    .client_metadata
  if (clientMetadata && typeof clientMetadata === "object") {
    const marker = (clientMetadata as Record<string, unknown>)[
      "ws_request_header_x_openai_internal_codex_responses_lite"
    ]
    if (isResponsesLiteMarker(marker)) {
      return true
    }
  }

  return false
}

function isResponsesLiteMarker(value: unknown): boolean {
  return (
    value === true
    || (typeof value === "string" && value.trim().toLowerCase() === "true")
  )
}

/**
 * Resolve the `parallel_tool_calls` value to send upstream, mirroring CPA's
 * normalizeCodexParallelToolCalls:
 *   - Responses Lite requests must send false (upstream rejects true together
 *     with the Lite marker).
 *   - Non-Lite requests keep the client's explicit value when tools are
 *     present; when no tools are present the field is dropped entirely
 *     (CPA deletes it — it is meaningless without tools).
 *   - Default (client omitted the field): true.
 */
function resolveCodexParallelToolCalls(
  payload: ResponsesPayload,
  responsesLite: boolean,
): boolean | undefined {
  if (responsesLite) return false
  const tools = (payload as { tools?: unknown }).tools
  const hasTools = Array.isArray(tools) && tools.length > 0
  if (!hasTools) return undefined
  if (typeof payload.parallel_tool_calls === "boolean") {
    return payload.parallel_tool_calls
  }
  return true
}

/**
 * Codex upstream does not accept the "system" role in input items (CPA
 * convertSystemRoleToDeveloper: "Codex API does not accept 'system' role in
 * the input array"). Rewrite role "system" → "developer" without mutating the
 * caller's payload; returns the original array when nothing needs changing.
 */
function convertSystemRoleToDeveloper(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input
  }
  // Mutable state object so the linter's control-flow analysis keeps
  // `changed` a plain boolean (it is only flipped inside the map callback).
  const state = { changed: false }
  const items = (input as Array<unknown>).map((item) => {
    if (
      item !== null
      && typeof item === "object"
      && !Array.isArray(item)
      && (item as { role?: unknown }).role === "system"
    ) {
      state.changed = true
      return { ...(item as Record<string, unknown>), role: "developer" }
    }
    return item
  })
  return state.changed ? items : input
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
  }
  return finalized
}

/**
 * Builds the body sent to the Codex upstream /responses endpoint.
 *
 * Codex /responses rejects many standard Responses API parameters with
 * "Unsupported parameter: <name>". Strip them out before forwarding.
 * See CLIProxyAPI codex_openai-responses_request.go for the reference set.
 * Preserve the client's `include` items and append reasoning.encrypted_content
 * (needed for cross-turn replay under store=false) instead of overwriting -
 * overwriting drops include items the client needs (e.g. reasoning summary
 * controls), which can suppress visible thinking output. Matches oh-my-pi
 * `applyResponsesCompatPolicy` (openai-shared.ts:3192-3195).
 */
function buildCodexUpstreamBody(
  payload: ResponsesPayload,
  model: string,
  responsesLite: boolean,
): Record<string, unknown> {
  const rawInclude = (payload as { include?: unknown }).include
  const clientInclude: Array<string> =
    Array.isArray(rawInclude) ? (rawInclude as Array<string>) : []
  const parallelToolCalls = resolveCodexParallelToolCalls(
    payload,
    responsesLite,
  )
  // CPA preserves only stream_options.reasoning_summary_delivery (read before
  // deleting stream_options, then re-set). include_usage etc. are dropped.
  const reasoningSummaryDelivery = (
    payload as unknown as {
      stream_options?: { reasoning_summary_delivery?: unknown }
    }
  ).stream_options?.reasoning_summary_delivery
  // CPA keeps only service_tier "priority" and strips every other value.
  const serviceTier = (payload as unknown as { service_tier?: unknown })
    .service_tier
  return {
    ...payload,
    model,
    stream: true,
    store: false,
    parallel_tool_calls: parallelToolCalls,
    include:
      clientInclude.includes("reasoning.encrypted_content") ? clientInclude : (
        [...clientInclude, "reasoning.encrypted_content"]
      ),
    ...withDefaultReasoningSummary(payload.reasoning),
    instructions:
      typeof payload.instructions === "string" ? payload.instructions : "",
    // `input`-level normalization (system→developer) happens once, last, in
    // `finalizeCodexOutboundBody` — every send site applies it there instead
    // of here so it can never be bypassed by a path that rebuilds `input`.
    input: payload.input,
    previous_response_id: undefined,
    prompt_cache_retention: undefined,
    safety_identifier: undefined,
    stream_options:
      reasoningSummaryDelivery === undefined ? undefined : (
        { reasoning_summary_delivery: reasoningSummaryDelivery }
      ),
    max_output_tokens: undefined,
    max_completion_tokens: undefined,
    temperature: undefined,
    top_p: undefined,
    truncation: undefined,
    user: undefined,
    context_management: undefined,
    service_tier: serviceTier === "priority" ? "priority" : undefined,
  }
}

/**
 * Remove all `reasoning` items from a Responses `input` array.
 *
 * The OpenAI Responses API accepts reasoning items in only two valid shapes:
 * fully paired (each reasoning item immediately followed by the item it
 * reasoned about) or omitted entirely. A partially-stripped input triggers a
 * 400 ("reasoning ... provided without its required following item"), so we
 * drop *every* reasoning item and keep messages / function_call /
 * custom_tool_call and their outputs intact.
 *
 * Used for self-contained replays (fresh WS socket / HTTP fallback) where the
 * accumulated transcript's historical `reasoning.encrypted_content` blobs are
 * both the bulk of the payload (blowing past the WS frame the upstream can
 * process) and stale relative to the freshly dialed upstream context. Dropping
 * them shrinks the replay and avoids stale-signature rejections; the only cost
 * is losing cross-turn chain-of-thought continuity on the (rare) recovery path.
 */
export function stripReasoningItems(input: Array<unknown>): Array<unknown> {
  return input.filter(
    (item) =>
      item === null
      || typeof item !== "object"
      || (item as { type?: unknown }).type !== "reasoning",
  )
}

/**
 * Reject a chained Codex /responses request that would otherwise travel over
 * plain HTTP. `previous_response_id` is WebSocket-only (CPA): a fresh HTTP
 * request has no server-side conversation chain to reference, so forwarding
 * the incremental delta would yield a useless `function_call_output` with no
 * matching `function_call` upstream. Clients (Crush's Responses chaining)
 * detect the `previous_response_not_found` marker and retry with a full
 * self-contained replay instead.
 */
export function chainedHttpCodexRequestError(): HTTPError {
  const errorBody = JSON.stringify({
    error: {
      type: "invalid_request_error",
      code: "previous_response_not_found",
      message:
        "Chained Codex requests require WebSocket transport or full replay.",
    },
  })
  return new HTTPError(
    "previous_response_not_found: chained Codex request requires full replay",
    new Response(errorBody, { status: 409 }),
    errorBody,
  )
}

function assertChainedHttpReplayAvailable(
  previousResponseId: string | undefined,
  useUpstreamWs: boolean,
  httpFallbackBody: Record<string, unknown> | undefined,
  memoryTraceId: string | undefined,
): void {
  if (previousResponseId && !useUpstreamWs && !httpFallbackBody) {
    // Telemetry for how often the 409 recovery-required path actually fires
    // in real traffic (no client-supplied stable session id, or the
    // transcript for one was evicted/never written) — see P2 goal of making
    // cap-tuning (ws-transcript-cache.ts MAX_TRANSCRIPT_* ) answerable from
    // telemetry instead of guesswork.
    updateMemoryTrace(memoryTraceId, "transcript_replay_unavailable", {
      provider: "codex",
    })
    throw chainedHttpCodexRequestError()
  }
}

export async function createCodexResponsesOnce(
  account: Account,
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  if (!isOAuthAccount(account) || account.provider !== "codex") {
    throw new Error("Codex responses requires a Codex OAuth account")
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(`Codex access token missing for account "${account.label}"`)
  }

  const model = canonicalNativeModelId(payload.model)
  const memoryTraceId = readMemoryTraceId(ctx)
  const baseUrl = account.settings?.baseUrl ?? CODEX_API_BASE_URL
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`
  const clientStream = payload.stream === true
  const useUpstreamWs =
    !ctx?.forceUpstreamHttp
    && shouldUseUpstreamResponsesWebsocket(account, "codex", ctx)
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
    account.id,
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
    ...buildCodexHeaders(account, accessToken, true, {
      sessionId,
      threadId,
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
    || account.id
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
        model,
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

  if (useUpstreamWs) {
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
        account,
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
      return await collectResponsesFromWsStream(
        wrapCodexStream(tracked, model, scopedReplaySessionKey, identityState),
        model,
        identityState,
      )
    } catch (error) {
      if (isAbortLikeError(error) || signal?.aborted) throw error
      const failure = classifyWsFailure(error)
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
        destroyUpstreamWebsocketSession("codex", account.id, executionSessionId)
      }
      logger.warn(
        `codex websockets: falling back to HTTP: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const response = await postCodexResponses({
    account,
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

async function collectResponsesFromWsStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  _model: string,
  identityState: IdentityConfuseState,
): Promise<ResponsesResponse> {
  let completed: ResponsesResponse | undefined
  for await (const event of stream) {
    if (!event.data || event.data === "[DONE]") continue
    try {
      const parsed = JSON.parse(event.data) as Record<string, unknown>
      if (
        parsed.type === "response.completed"
        && parsed.response
        && typeof parsed.response === "object"
      ) {
        completed = parsed.response as ResponsesResponse
      }
    } catch {
      // ignore partial frames
    }
  }
  if (!completed) {
    throw new Error("Codex websockets: missing response.completed event")
  }
  if (identityState.enabled) {
    const restored = restoreIdentityConfuseResponse(
      JSON.stringify(completed),
      identityState,
    )
    return JSON.parse(restored) as ResponsesResponse
  }
  return completed
}

/**
 * Passthrough generator that, on each `response.completed`, appends the
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
    if (data && data !== "[DONE]" && data.includes('"response.completed"')) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (parsed.type === "response.completed") {
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
  account: Account
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
  return fetchWithOAuthProxy(options.account, options.url, {
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

/** Handles a single `response.completed` SSE frame: cache + debug-log. */
function handleCodexStreamCompletion(
  parsed: Record<string, unknown>,
  model: string,
  replaySessionKey: string | undefined,
): void {
  if (parsed.type !== "response.completed") return
  if (replaySessionKey) {
    void cacheReasoningReplayItems(model, replaySessionKey, parsed)
  }
  const output = (
    parsed.response as { output?: Array<Record<string, unknown>> }
  ).output
  logCodexReasoningSummary(
    "[codex] response.completed reasoning summary",
    output,
  )
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

    // Cache reasoning items on response.completed events.
    if (data.includes('"response.completed"')) {
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
