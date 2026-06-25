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
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { collectResponsesFromSseResponse } from "~/services/responses/sse-collector"

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
 *   3. Random UUID fallback (breaks prefix caching — only used when neither
 *      the body nor the header provides a stable identifier).
 *
 * Priority for thread_id (sent as x-client-request-id):
 *   1. `thread_id` / `thread-id` from the forwarded incoming request header.
 *   2. Random UUID fallback.
 */
function resolveCodexSessionHeaders(
  payload: ResponsesPayload,
  ctx?: RequestExecutionContext,
): { sessionId?: string; threadId?: string } {
  // 1. prompt_cache_key from body (highest priority — matches codex CLI + CPA)
  const bodyCacheKey = (payload as unknown as { prompt_cache_key?: unknown })
    .prompt_cache_key
  if (typeof bodyCacheKey === "string" && bodyCacheKey.trim()) {
    const forwarded = ctx?.forwardedHeaders
    const threadId = forwarded?.["thread_id"] ?? forwarded?.["thread-id"]
    return {
      sessionId: bodyCacheKey.trim(),
      threadId: typeof threadId === "string" ? threadId : undefined,
    }
  }

  // 2. session_id from forwarded headers
  const forwarded = ctx?.forwardedHeaders
  if (!forwarded) {
    return {}
  }
  const sessionId = forwarded["session_id"] ?? forwarded["session-id"]
  const threadId = forwarded["thread_id"] ?? forwarded["thread-id"]
  return {
    sessionId: typeof sessionId === "string" ? sessionId : undefined,
    threadId: typeof threadId === "string" ? threadId : undefined,
  }
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
  ]) {
    const value = forwarded[key]
    if (typeof value === "string" && value.trim()) {
      extra[key] = value.trim()
    }
  }
  return extra
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
  const { sessionId, threadId } = resolveCodexSessionHeaders(payload, ctx)
  const extraHeaders = resolveCodexExtraHeaders(ctx)

  // Codex /responses rejects many standard Responses API parameters with
  // "Unsupported parameter: <name>". Strip them out before forwarding.
  // See CLIProxyAPI codex_openai-responses_request.go for the reference set.
  const upstreamBody: Record<string, unknown> = {
    ...payload,
    model,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    // Normalize instructions: null → "" for consistent cache keys
    instructions:
      typeof payload.instructions === "string" ? payload.instructions : "",
    // Unsupported parameters — must be stripped
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

  // ── Build headers ────────────────────────────────────────────────────
  const headers: Record<string, string> = {
    ...buildCodexHeaders(account, accessToken, true, {
      sessionId,
      threadId,
    }),
    ...extraHeaders,
  }
  // Apply identity confuse to headers (remaps Session_id, turn metadata, etc.)
  applyIdentityConfuseHeaders(headers, identityState)

  const response = await fetchWithOAuthProxy(account, url, {
    method: "POST",
    headers,
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

    // Cache reasoning items on response.completed.
    if (replaySessionKey && data.includes('"response.completed"')) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        void cacheReasoningReplayItems(model, replaySessionKey, parsed)
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
