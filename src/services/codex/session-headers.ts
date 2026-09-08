/**
 * Codex session / thread identity resolution + forwarded-header extraction.
 *
 * 从 create-responses-once.ts 拆出：压缩与普通 turn 共用，且与主流程无耦合。
 */
import type { ResponsesPayload } from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { extractSessionIds, resolveStableSessionId } from "~/lib/routing"

export interface ResolvedCodexSessionHeaders {
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
 * Priority for thread_id (sent as `thread-id` on HTTP and as
 * `x-client-request-id` on the WebSocket handshake):
 *   1. `thread_id` / `thread-id` from the forwarded incoming request header
 *      (the spelling the official client uses on HTTP).
 *   2. `x-client-request-id` from the forwarded incoming request header
 *      (proxy-fronted clients that reused the WS spelling on HTTP).
 *   3. Omitted (the official client never invents a random thread id).
 */
export function resolveCodexSessionHeaders(
  payload: ResponsesPayload,
  ctx?: RequestExecutionContext,
): ResolvedCodexSessionHeaders {
  const forwarded = ctx?.forwardedHeaders
  const threadIdRaw =
    forwarded?.["thread_id"]
    ?? forwarded?.["thread-id"]
    ?? forwarded?.["x-client-request-id"]
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
export function resolveCodexExtraHeaders(
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
    // Always sent by the official client on HTTP (client.rs
    // ModelClientSession::stream): per-installation identity.
    "x-codex-installation-id",
    // Server-echoed turn state: the official client sends back the value
    // received on a previous response (`x-codex-turn-state` response
    // header). Forward the downstream client's value verbatim.
    "x-codex-turn-state",
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
