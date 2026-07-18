/**
 * Codex WebSocket transcript cache.
 *
 * Codex drives its upstream via a persistent Responses WebSocket and, within a
 * turn's tool loop, chains requests using `previous_response_id` + an
 * *incremental* input delta (see codex core `prepare_websocket_request`). Codex
 * forces `store: false`, so a `previous_response_id` is only resolvable on the
 * exact upstream socket that produced it.
 *
 * copilot-api reuses/recycles its upstream sockets (idle timeout, ~55m redial,
 * transport drops). When it must dial a *fresh* upstream socket mid-session, the
 * new socket has zero server-side memory, so any `previous_response_id` the
 * codex client sends is rejected with:
 *
 *   "Previous response with id 'resp_...' not found."
 *
 * Because the wire input at that point is only the incremental delta, the fix
 * cannot simply drop `previous_response_id` — the full conversation would be
 * lost. Instead we accumulate the full input transcript per client session so a
 * self-contained request (full input, no `previous_response_id`) can be
 * replayed on a fresh socket. This is a server-side concern only; the codex
 * client is untouched and unaware.
 *
 * The transcript is the running full-input array a stateless Responses request
 * would need: every turn's input delta plus every completed response's output
 * items, in order. It lives in memory keyed by the downstream client WS session
 * id (+ model) and is cleared when that client socket disconnects.
 */

interface TranscriptEntry {
  fullInput: Array<unknown>
  updatedAt: number
}

const transcripts = new Map<string, TranscriptEntry>()

/**
 * Recovery is a best-effort optimization; drop transcripts for very long
 * conversations rather than risk unbounded memory growth. When dropped, the
 * session simply falls back to the pre-fix behavior (dangling
 * previous_response_id may fail on a fresh socket) instead of leaking memory.
 */
const MAX_TRANSCRIPT_ITEMS = 4000

/** Evict transcripts untouched for longer than this. */
const TRANSCRIPT_IDLE_MS = 60 * 60_000

/** Build the map key for a client session + model pair. */
export type ResponsesTranscriptProvider = "codex" | "xai"

/** Build the provider-scoped map key for a client session + model triple. */
function transcriptKey(
  provider: ResponsesTranscriptProvider,
  executionSessionId: string,
  model: string,
): string {
  return `${provider}::${executionSessionId}::${model}`
}

/** Codex-scoped transcript key. */
export function codexTranscriptKey(
  executionSessionId: string,
  model: string,
): string {
  return transcriptKey("codex", executionSessionId, model)
}

/** xAI-scoped transcript key. */
export function xaiTranscriptKey(
  executionSessionId: string,
  model: string,
): string {
  return transcriptKey("xai", executionSessionId, model)
}

/** Returns the accumulated full input for a session, if present. */
export function getCodexTranscript(key: string): Array<unknown> | undefined {
  const entry = transcripts.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.updatedAt > TRANSCRIPT_IDLE_MS) {
    transcripts.delete(key)
    return undefined
  }
  return entry.fullInput
}

/**
 * Stores the accumulated full input for a session. Oversized transcripts are
 * dropped (not stored) so recovery degrades gracefully instead of leaking.
 */
export function setCodexTranscript(
  key: string,
  fullInput: Array<unknown>,
): void {
  pruneIdleTranscripts()
  if (fullInput.length > MAX_TRANSCRIPT_ITEMS) {
    transcripts.delete(key)
    return
  }
  transcripts.set(key, { fullInput, updatedAt: Date.now() })
}

/** Clears a single transcript by exact key. */
export function clearCodexTranscript(key: string): void {
  transcripts.delete(key)
}

// Provider-agnostic aliases (the store is keyed by a provider-scoped key, so
// the same get/set/clear serve codex and xAI without cross-provider bleed).
export const getResponsesTranscript = getCodexTranscript
export const setResponsesTranscript = setCodexTranscript
export const clearResponsesTranscript = clearCodexTranscript

/**
 * Clears every transcript bound to a downstream client WS session id, across
 * all providers. Called when the client socket closes (mirrors upstream WS
 * session teardown). Matches the `executionSessionId::` segment after the
 * provider prefix, so it never clears a lookalike session id.
 */
export function clearResponsesTranscriptsByExecutionId(
  executionSessionId: string,
): number {
  const id = executionSessionId.trim()
  if (!id) return 0
  let cleared = 0
  for (const key of transcripts.keys()) {
    // key = `${provider}::${executionSessionId}::${model}`.
    const sep = key.indexOf("::")
    if (sep === -1) continue
    const rest = key.slice(sep + 2)
    if (rest.startsWith(`${id}::`)) {
      transcripts.delete(key)
      cleared += 1
    }
  }
  return cleared
}

function pruneIdleTranscripts(now = Date.now()): void {
  for (const [key, entry] of transcripts) {
    if (now - entry.updatedAt > TRANSCRIPT_IDLE_MS) {
      transcripts.delete(key)
    }
  }
}

/** Test hook: drop all cached transcripts. */
export function clearCodexTranscriptsForTest(): void {
  transcripts.clear()
}

/** Test hook: live transcript count. */
export function getCodexTranscriptCountForTest(): number {
  return transcripts.size
}
