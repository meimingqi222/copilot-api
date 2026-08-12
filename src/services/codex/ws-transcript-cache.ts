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
 * items, in order. It lives in memory keyed by an authenticated client scope,
 * stable conversation id and model. Anonymous clients without a stable id
 * remain socket-scoped and are cleared when that socket disconnects.
 */

import { globalTimers } from "~/lib/timer-registry"

interface TranscriptEntry {
  fullInput: Array<unknown>
  updatedAt: number
  bytes: number
}

export interface TranscriptStoreResult {
  stored: boolean
  entryBytes: number
  totalBytes: number
  entries: number
}

const transcripts = new Map<string, TranscriptEntry>()
let transcriptBytes = 0

/**
 * Recovery is a best-effort optimization; drop transcripts for very long
 * conversations rather than risk unbounded memory growth. When dropped, the
 * session simply falls back to the pre-fix behavior (dangling
 * previous_response_id may fail on a fresh socket) instead of leaking memory.
 */
const MAX_TRANSCRIPT_ITEMS = 4000

/** A 1M-token text context is roughly 4 MiB; allow bounded JSON overhead. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
/** Keep the recovery cache well below the memory budget of a 1 GiB server. */
const MAX_TOTAL_TRANSCRIPT_BYTES = 32 * 1024 * 1024
const MAX_TRANSCRIPT_ENTRIES = 256

/** Evict transcripts untouched for longer than this. */
const TRANSCRIPT_IDLE_MS = 60 * 60_000

/** Build the map key for a client session (conversation-scoped, not model). */
export type ResponsesTranscriptProvider = "codex" | "xai"

/**
 * Build the provider-scoped map key for a client session.
 *
 * Deliberately NOT keyed by model: Codex Desktop / waku alternate models
 * within one conversation (multi-agent sub-turns, e.g. gpt-5.6-sol ↔
 * gpt-5.6-terra). A per-model key makes the fresh-socket full replay miss the
 * function_calls produced under the other model, and the replayed turn is
 * rejected with "No tool call found for custom tool call output with call_id
 * ..." after an account switch / socket redial. The session id is chosen by
 * the client per conversation, so it already isolates conversations.
 */
function transcriptKey(
  provider: ResponsesTranscriptProvider,
  executionSessionId: string,
): string {
  return `${provider}::${executionSessionId}`
}

/** Codex-scoped transcript key. */
export function codexTranscriptKey(executionSessionId: string): string {
  return transcriptKey("codex", executionSessionId)
}

/** xAI-scoped transcript key. */
export function xaiTranscriptKey(executionSessionId: string): string {
  return transcriptKey("xai", executionSessionId)
}

/**
 * Prefer an explicit client conversation key for transcript recovery across a
 * downstream WebSocket reconnect. Fall back to the physical socket id when the
 * client supplied no stable identity, preserving isolation for anonymous use.
 */
export function resolveResponsesTranscriptSessionId(
  executionSessionId: string,
  preferredSessionId?: string,
  scopeId?: string,
): string {
  const preferred = preferredSessionId?.trim()
  if (!preferred) return executionSessionId
  const scope = scopeId?.trim()
  return scope ? `${scope}::${preferred}` : preferred
}

/** Returns the accumulated full input for a session, if present. */
export function getCodexTranscript(key: string): Array<unknown> | undefined {
  const entry = transcripts.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.updatedAt > TRANSCRIPT_IDLE_MS) {
    deleteTranscript(key)
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
): TranscriptStoreResult {
  pruneIdleTranscripts()
  const bytes = estimateJsonBytes(fullInput, MAX_TRANSCRIPT_BYTES)
  if (fullInput.length > MAX_TRANSCRIPT_ITEMS || bytes > MAX_TRANSCRIPT_BYTES) {
    deleteTranscript(key)
    return transcriptStoreResult(false, bytes)
  }
  deleteTranscript(key)
  transcripts.set(key, { fullInput, updatedAt: Date.now(), bytes })
  transcriptBytes += bytes
  pruneTranscriptCapacity()
  return transcriptStoreResult(transcripts.has(key), bytes)
}

/**
 * Appends completed output items and stores the result. Builds a *new* array
 * rather than pushing onto `fullInput` in place: `fullInput` can be
 * `buildResponsesTranscriptInput`'s untracked return value, which is the
 * caller's own `payload.input` array by reference (not a copy) — mutating it
 * here would leak upstream response output items into the caller's payload
 * object. Previously this was safe only because every call site happened to
 * gate the write on the same condition `buildResponsesTranscriptInput` used
 * to decide whether to copy; making this non-mutating removes that implicit
 * coupling between two independent call sites.
 */
export function appendCodexTranscript(
  key: string,
  fullInput: Array<unknown>,
  output: Array<unknown>,
): TranscriptStoreResult {
  return setCodexTranscript(key, [...fullInput, ...output])
}

/**
 * Build a replay array only when transcript tracking needs ownership.
 *
 * When a cached transcript exists, dedupe the raw delta against it by item id
 * (delta wins — it is the client's newer copy). Without this, a client that
 * re-sends previous turns (full replay after `previous_response_not_found`,
 * or a tool-result turn that repeats the preceding turn's items) would
 * produce duplicate ids upstream and get rejected. Items without an `id`
 * (e.g. plain message items some clients omit ids for) are always kept.
 */
export function buildResponsesTranscriptInput(
  cachedFull: Array<unknown> | undefined,
  rawDelta: Array<unknown>,
  track: boolean,
): Array<unknown> {
  if (!cachedFull) {
    return track ? [...rawDelta] : rawDelta
  }
  const deltaKeys = new Set<string>()
  for (const entry of rawDelta) {
    const key = transcriptItemKey(entry)
    if (key) deltaKeys.add(key)
  }
  if (deltaKeys.size === 0) {
    return [...cachedFull, ...rawDelta]
  }
  const merged = cachedFull.filter((entry) => {
    const key = transcriptItemKey(entry)
    return key === undefined || !deltaKeys.has(key)
  })
  return [...merged, ...rawDelta]
}

function transcriptItemKey(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined
  const item = entry as Record<string, unknown>
  const id = typeof item.id === "string" ? item.id.trim() : ""
  if (!id) return undefined
  const type = typeof item.type === "string" ? item.type : ""
  return `${type}:${id}`
}

function transcriptStoreResult(
  stored: boolean,
  entryBytes: number,
): TranscriptStoreResult {
  return {
    stored,
    entryBytes,
    totalBytes: transcriptBytes,
    entries: transcripts.size,
  }
}

/** Clears a single transcript by exact key. */
export function clearCodexTranscript(key: string): void {
  deleteTranscript(key)
}

// Provider-agnostic aliases (the store is keyed by a provider-scoped key, so
// the same get/set/clear serve codex and xAI without cross-provider bleed).
export const getResponsesTranscript = getCodexTranscript
export const setResponsesTranscript = setCodexTranscript
export const appendResponsesTranscript = appendCodexTranscript
export const clearResponsesTranscript = clearCodexTranscript

/**
 * Clears every socket-scoped transcript bound to a downstream client WS id,
 * across all providers. Stable conversation-scoped transcripts deliberately
 * use a different key and survive reconnects until their TTL/capacity eviction.
 * Matches the exact id segment so it never clears a lookalike session id.
 */
export function clearResponsesTranscriptsByExecutionId(
  executionSessionId: string,
): number {
  const id = executionSessionId.trim()
  if (!id) return 0
  let cleared = 0
  for (const key of transcripts.keys()) {
    // key = `<provider>::<session>` (session is conversation-scoped; the key
    // deliberately carries no model segment).
    const sep = key.indexOf("::")
    if (sep === -1) continue
    const rest = key.slice(sep + 2)
    // `rest` is either the bare execution session id (no client-supplied
    // stable id) or `<scope>::<stableSessionId>`. The equality branch clears
    // the former — that is what this function is for, and it is required now
    // that the key carries no trailing model segment. The prefix branch only
    // fires when `id` is itself the *scope* segment, so a socket-scoped call
    // never touches another principal's transcript, and a lookalike id
    // (`sess-1` vs `sess-10`) can never match either branch.
    if (rest === id || rest.startsWith(`${id}::`)) {
      deleteTranscript(key)
      cleared += 1
    }
  }
  return cleared
}

function pruneIdleTranscripts(now = Date.now()): void {
  for (const [key, entry] of transcripts) {
    if (now - entry.updatedAt > TRANSCRIPT_IDLE_MS) {
      deleteTranscript(key)
    }
  }
}

function pruneTranscriptCapacity(): void {
  while (
    transcripts.size > MAX_TRANSCRIPT_ENTRIES
    || transcriptBytes > MAX_TOTAL_TRANSCRIPT_BYTES
  ) {
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of transcripts) {
      if (entry.updatedAt < oldestAt) {
        oldestKey = key
        oldestAt = entry.updatedAt
      }
    }
    if (!oldestKey) return
    deleteTranscript(oldestKey)
  }
}

function deleteTranscript(key: string): void {
  const existing = transcripts.get(key)
  if (!existing) return
  transcriptBytes = Math.max(0, transcriptBytes - existing.bytes)
  transcripts.delete(key)
}

/** Estimate JSON UTF-8 bytes without allocating a second full JSON string. */
function estimateJsonBytes(value: unknown, limit: number): number {
  const seen = new WeakSet<object>()
  let bytes = 0

  const add = (amount: number): boolean => {
    bytes += amount
    return bytes <= limit
  }
  const addString = (value: string): boolean => {
    let escapedExtra = 0
    for (let index = 0; index < value.length; index += 1) {
      const code = value.codePointAt(index) ?? 0
      if (code === 0x22 || code === 0x5c) escapedExtra += 1
      else if (code < 0x20) escapedExtra += code >= 0x08 && code <= 0x0d ? 1 : 5
    }
    return add(Buffer.byteLength(value) + escapedExtra + 2)
  }
  const visit = (current: unknown): boolean => {
    if (current === null) return add(4)
    switch (typeof current) {
      case "string": {
        return addString(current)
      }
      case "boolean": {
        return add(current ? 4 : 5)
      }
      case "number": {
        return add(
          Buffer.byteLength(
            Number.isFinite(current) ? String(current) : "null",
          ),
        )
      }
      case "undefined": {
        return add(4)
      }
      case "object": {
        if (seen.has(current)) return false
        seen.add(current)
        const isArray = Array.isArray(current)
        if (!add(1)) return false
        let first = true
        for (const [key, child] of Object.entries(current)) {
          if (!first && !add(1)) return false
          first = false
          if (!isArray && (!addString(key) || !add(1))) return false
          if (!visit(child)) return false
        }
        seen.delete(current)
        return add(1)
      }
      default: {
        return false
      }
    }
  }

  return visit(value) ? bytes : limit + 1
}

globalTimers.interval(() => pruneIdleTranscripts(), 5 * 60_000)

/** Test hook: drop all cached transcripts. */
export function clearCodexTranscriptsForTest(): void {
  transcripts.clear()
  transcriptBytes = 0
}

/** Test hook: live transcript count. */
export function getCodexTranscriptCountForTest(): number {
  return transcripts.size
}

/** Test hook: total estimated bytes retained by transcripts. */
export function getCodexTranscriptBytesForTest(): number {
  return transcriptBytes
}
