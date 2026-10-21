/**
 * Responses WebSocket transcript cache and replay input helpers.
 *
 * Shared by stateful Responses providers (Codex, xAI, and OpenAI-compatible
 * Responses transcripts) so incremental `previous_response_id` turns can
 * replay a self-contained transcript when an upstream WebSocket redials or
 * falls back to HTTP.
 */

import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { globalTimers } from "~/lib/timer-registry"
import type { CopilotStreamEventLike } from "~/services/protocols/responses/types"

interface TranscriptEntry {
  fullInput: Array<unknown>
  updatedAt: number
  bytes: number
}

interface TranscriptStoreResult {
  stored: boolean
  entryBytes: number
  totalBytes: number
  entries: number
}

const transcripts = new Map<string, TranscriptEntry>()
let transcriptBytes = 0

const MAX_TRANSCRIPT_ITEMS = 4000
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_TRANSCRIPT_BYTES = 32 * 1024 * 1024
const MAX_TRANSCRIPT_ENTRIES = 256
const TRANSCRIPT_IDLE_MS = 60 * 60_000

type ResponsesTranscriptProvider = "codex" | "xai"

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

export function resolveSocketResponsesTranscriptSessionId(
  executionSessionId: string,
  providerSessionId?: string,
  scopeId?: string,
): string {
  const providerSession = providerSessionId?.trim()
  return resolveResponsesTranscriptSessionId(
    executionSessionId,
    providerSession === executionSessionId ? undefined : providerSession,
    scopeId,
  )
}

export function getCodexTranscript(key: string): Array<unknown> | undefined {
  const entry = transcripts.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.updatedAt > TRANSCRIPT_IDLE_MS) {
    deleteTranscript(key)
    return undefined
  }
  return entry.fullInput
}

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

export function appendCodexTranscript(
  key: string,
  fullInput: Array<unknown>,
  output: Array<unknown>,
): TranscriptStoreResult {
  return setCodexTranscript(key, [...fullInput, ...output])
}

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
  const type = typeof item.type === "string" ? item.type.trim() : ""
  if (id) return `${type}:id:${id}`

  if (
    type === "function_call"
    || type === "custom_tool_call"
    || type === "function_call_output"
    || type === "custom_tool_call_output"
  ) {
    const callId = typeof item.call_id === "string" ? item.call_id.trim() : ""
    if (callId) return `${type}:call_id:${callId}`
  }
  return undefined
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

export function clearCodexTranscript(key: string): void {
  deleteTranscript(key)
}

export function clearResponsesTranscriptsByExecutionId(
  executionSessionId: string,
): number {
  const id = executionSessionId.trim()
  if (!id) return 0
  let cleared = 0
  for (const key of transcripts.keys()) {
    const sep = key.indexOf("::")
    if (sep === -1) continue
    const rest = key.slice(sep + 2)
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

export function clearCodexTranscriptsForTest(): void {
  transcripts.clear()
  transcriptBytes = 0
}

export function getCodexTranscriptCountForTest(): number {
  return transcripts.size
}

export function getCodexTranscriptBytesForTest(): number {
  return transcriptBytes
}

// ── Replay tool-call pair pruning ──────────────────────────────────────────

const TOOL_OUTPUT_CALL_TYPES: Record<string, string> = {
  function_call_output: "function_call",
  custom_tool_call_output: "custom_tool_call",
}

function toolItemType(item: unknown): string | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return undefined
  }
  const type = (item as { type?: unknown }).type
  return typeof type === "string" ? type : undefined
}

function toolItemCallId(item: unknown): string | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return undefined
  }
  const callId = (item as { call_id?: unknown }).call_id
  return typeof callId === "string" && callId.trim() ? callId.trim() : undefined
}

function answeredToolCallKeys(input: Array<unknown>): Set<string> {
  const answered = new Set<string>()
  for (const entry of input) {
    const callType = TOOL_OUTPUT_CALL_TYPES[toolItemType(entry) ?? ""]
    const callId = toolItemCallId(entry)
    if (callType && callId) answered.add(`${callType}:${callId}`)
  }
  return answered
}

function isUnansweredToolCall(entry: unknown, answered: Set<string>): boolean {
  const callType = toolItemType(entry)
  if (callType !== "function_call" && callType !== "custom_tool_call") {
    return false
  }
  const callId = toolItemCallId(entry)
  if (!callId) return false
  return !answered.has(`${callType}:${callId}`)
}

/**
 * Drop tool calls that have no matching output in `input` when rebuilding a
 * self-contained replay transcript.
 */
export function pruneUnansweredToolCalls(
  input: Array<unknown>,
): Array<unknown> {
  const answered = answeredToolCallKeys(input)
  const result = input.filter((entry) => !isUnansweredToolCall(entry, answered))
  return result.length === input.length ? input : result
}

/** Count the tool calls in `input` that have no matching output. */
export function countUnansweredToolCalls(input: Array<unknown>): number {
  const answered = answeredToolCallKeys(input)
  let count = 0
  for (const entry of input) {
    if (isUnansweredToolCall(entry, answered)) count += 1
  }
  return count
}

export function recordTranscriptCheckpoint(
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
 * Passthrough generator that appends completed output items to the running
 * transcript on terminal SSE frames (`response.completed` / `response.incomplete`).
 */
export async function* recordResponsesTranscriptInStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  transcriptKey: string,
  fullInputThisTurn: Array<unknown>,
  memoryTraceId?: string,
  onTerminalEvent?: (parsed: Record<string, unknown>) => void,
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
          onTerminalEvent?.(parsed)
        }
      } catch {
        // Best-effort transcript recording.
      }
    }
    yield event
  }
}
