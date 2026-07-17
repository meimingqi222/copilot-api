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
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { extractSessionIds, resolveStableSessionId } from "~/lib/routing"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { collectResponsesFromSseResponse } from "~/services/responses/sse-collector"
import {
  applyCodexWebsocketHeaders,
  isAbortLikeError,
  isUpstreamWsTransportError,
  openUpstreamResponsesWebsocketTurn,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"

import { buildCodexHeaders } from "./headers"

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
): { sessionId?: string; threadId?: string } {
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
    return { sessionId: bodyCacheKey.trim(), threadId }
  }

  // 2. session_id from forwarded headers
  const headerSession = forwarded?.["session_id"] ?? forwarded?.["session-id"]
  if (typeof headerSession === "string" && headerSession.trim()) {
    return { sessionId: headerSession.trim(), threadId }
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
    return { sessionId: stableId, threadId }
  }

  return { threadId }
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
  const baseUrl = account.settings?.baseUrl ?? CODEX_API_BASE_URL
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`
  const clientStream = payload.stream === true
  const useUpstreamWs = shouldUseUpstreamResponsesWebsocket(
    account,
    "codex",
    ctx,
  )
  const { sessionId, threadId } = resolveCodexSessionHeaders(payload, ctx)
  const extraHeaders = resolveCodexExtraHeaders(ctx)
  const responsesLite = isResponsesLiteRequest(payload, ctx)

  // previous_response_id is WS-only (CPA). HTTP body always strips it.
  const previousResponseIdRaw = (payload as { previous_response_id?: unknown })
    .previous_response_id
  const previousResponseId =
    typeof previousResponseIdRaw === "string" ?
      previousResponseIdRaw.trim() || undefined
    : undefined

  // Codex /responses rejects many standard Responses API parameters with
  // "Unsupported parameter: <name>". Strip them out before forwarding.
  // See CLIProxyAPI codex_openai-responses_request.go for the reference set.
  const upstreamBody: Record<string, unknown> = {
    ...payload,
    model,
    stream: true,
    store: false,
    // Responses Lite requests must send parallel_tool_calls=false; every
    // other Codex responses request keeps the default of true. Mixing the
    // Responses Lite marker with parallel_tool_calls=true is rejected by the
    // ChatGPT backend.
    parallel_tool_calls: !responsesLite,
    include: ["reasoning.encrypted_content"],
    // Normalize instructions: null → "" for consistent cache keys
    instructions:
      typeof payload.instructions === "string" ? payload.instructions : "",
    // HTTP default: strip previous_response_id (WS path clones with it)
    previous_response_id: undefined,
    prompt_cache_retention: undefined,
    safety_identifier: undefined,
    stream_options: undefined,
    max_output_tokens: undefined,
    max_completion_tokens: undefined,
    temperature: undefined,
    top_p: undefined,
    truncation: undefined,
    user: undefined,
    context_management: undefined,
  }

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
    : (sessionId ?? "")

  // ── Identity Confuse ────────────────────────────────────────────────
  // Remap prompt_cache_key to a per-account deterministic UUID so that
  // multi-account load balancing doesn't break cache affinity.
  const identityState = applyIdentityConfuseBody(
    account.id,
    payload as unknown as Record<string, unknown>,
    upstreamBody,
  )

  // Inject cached reasoning items from previous turns in this session.
  if (replaySessionKey) {
    const replayItems = await getReasoningReplayItems(model, replaySessionKey)
    if (replayItems && replayItems.length > 0) {
      injectReasoningReplayItems(upstreamBody, replayItems)
    }
  }

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
  if (useUpstreamWs) {
    const executionSessionId =
      ctx?.executionSessionId?.trim()
      || sessionId
      || replaySessionKey
      || account.id
    const wsBody: Record<string, unknown> = {
      ...upstreamBody,
      previous_response_id: previousResponseId,
    }
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
      })
      const normalized = normalizeResponsesStreamIds(wsStream)
      if (clientStream) {
        return wrapCodexStream(
          normalized,
          model,
          replaySessionKey,
          identityState,
        )
      }
      return await collectResponsesFromWsStream(
        wrapCodexStream(normalized, model, replaySessionKey, identityState),
        model,
        identityState,
      )
    } catch (error) {
      if (isAbortLikeError(error) || signal?.aborted) throw error
      // Application errors from upstream WS (response.failed) — do not re-POST.
      if (!isUpstreamWsTransportError(error)) throw error
      logger.warn(
        `codex websockets: falling back to HTTP: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const response = await fetchWithOAuthProxy(account, url, {
    method: "POST",
    headers: httpHeaders,
    // HTTP path: no previous_response_id (already stripped on upstreamBody)
    body: JSON.stringify(upstreamBody),
    signal,
  })

  if (!response.ok) {
    // Clear reasoning replay cache on thinking_signature_invalid errors.
    const errorBody = await response.text().catch(() => "")
    if (
      response.status === 400
      && errorBody.includes("thinking_signature_invalid")
      && replaySessionKey
    ) {
      await deleteReasoningReplayItems(model, replaySessionKey)
    }
    throw new HTTPError(
      "Failed to create Codex responses",
      response,
      errorBody || "(unreadable)",
    )
  }

  if (clientStream) {
    const stream = await safeSseStream(response, detectResponsesStreamError)
    return wrapCodexStream(
      normalizeResponsesStreamIds(
        stream as unknown as AsyncIterable<CopilotStreamEventLike>,
      ),
      model,
      replaySessionKey,
      identityState,
    )
  }

  const result = await collectResponsesFromSseResponse(response, model)
  // Cache reasoning items from the completed response.
  // `result` is the response object itself (has `output`), so we pass it
  // directly — cacheReasoningReplayItems checks both `.response.output`
  // (SSE event shape) and `.output` (collected response shape).
  if (replaySessionKey) {
    void cacheReasoningReplayItems(
      model,
      replaySessionKey,
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
 * Wraps a Codex SSE stream to:
 * 1. Cache reasoning items from `response.completed` events.
 * 2. Restore original identifiers (identity confuse) in all events.
 */
async function* wrapCodexStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  model: string,
  replaySessionKey: string,
  identityState: IdentityConfuseState,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    let data = event.data
    if (!data || data === "[DONE]") {
      yield event
      continue
    }

    // Cache reasoning items on response.completed events.
    if (replaySessionKey && data.includes('"response.completed"')) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        // Only cache if this is actually a response.completed event.
        if (parsed.type === "response.completed") {
          void cacheReasoningReplayItems(model, replaySessionKey, parsed)
        }
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
