import type { RedactionMatch } from "~/lib/redaction/rules"

interface RedactionDiagnostics {
  total: number
  byKind: Record<RedactionMatch["kind"], number>
  bySource: Record<RedactionMatch["source"], number>
  maskingMs: number
  restored: number
}

export function emptyRedactionDiagnostics(): RedactionDiagnostics {
  return {
    total: 0,
    byKind: { SECRET: 0, HOME: 0, WORD: 0 },
    bySource: { builtin: 0, word: 0, homePrefix: 0, field: 0, known: 0 },
    maskingMs: 0,
    restored: 0,
  }
}

interface RecentRedaction extends RedactionDiagnostics {
  id: number
  timestamp: number
  client: string
  upstreams: Array<RedactionUpstream>
  captureId?: number
}

const LIMIT = 100
let sequence = 0
const recent: Array<RecentRedaction> = []

export interface RedactionUpstream {
  id: string
  name: string
  protocol: string
  model: string
}

interface InspectionMapping {
  placeholder: string
  kind: RedactionMatch["kind"]
  source: RedactionMatch["source"]
  value: string
}

interface InspectionAttempt {
  upstream: RedactionUpstream
  stage: "http" | "adapter"
  body: string
  truncated: boolean
}

interface InspectionCapture {
  input: string
  attempts: Array<InspectionAttempt>
  mappings: Array<InspectionMapping>
  truncated: boolean
  bytes: number
}

const TTL_MS = 5 * 60_000
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ENTRY_BYTES = 128 * 1024
const captures = new Map<number, InspectionCapture>()
let captureSequence = 0
let inspectionExpiresAt = 0
let inspectionTimer: ReturnType<typeof setTimeout> | undefined
let captureBytes = 0

export function clearRedactionInspection(): void {
  captures.clear()
  captureBytes = 0
}

export function getRedactionInspectionState() {
  if (inspectionExpiresAt <= Date.now()) {
    inspectionExpiresAt = 0
    clearRedactionInspection()
  }
  return {
    enabled: inspectionExpiresAt > 0,
    expiresAt: inspectionExpiresAt || null,
    ttlMs: TTL_MS,
    maxBytes: MAX_BYTES,
    maxEntryBytes: MAX_ENTRY_BYTES,
    bytes: captureBytes,
  }
}

/** Explicit, temporary opt-in. Revocation also invalidates captures still in flight. */
export function setRedactionInspection(enabled: boolean) {
  clearTimeout(inspectionTimer)
  clearRedactionInspection()
  inspectionExpiresAt = enabled ? Date.now() + TTL_MS : 0
  if (enabled)
    inspectionTimer = setTimeout(() => {
      inspectionExpiresAt = 0
      clearRedactionInspection()
    }, TTL_MS).unref()
  return getRedactionInspectionState()
}

function dropCapture(id: number): void {
  const capture = captures.get(id)
  if (capture) captureBytes -= capture.bytes
  captures.delete(id)
}

function chargeText(capture: InspectionCapture, bytes: number): void {
  capture.bytes += bytes
  captureBytes += bytes
  // A pending old request may grow after newer requests. Never detach the
  // capture being updated: its subsequent reservations must remain accounted.
  for (const [id, other] of captures) {
    if (captureBytes <= MAX_BYTES) break
    if (other !== capture) dropCapture(id)
  }
}

function keepFields(
  capture: InspectionCapture,
  fields: Array<string>,
): boolean {
  const bytes = fields.reduce((sum, text) => sum + text.length * 2, 0)
  if (bytes > MAX_ENTRY_BYTES - capture.bytes) {
    capture.truncated = true
    return false
  }
  chargeText(capture, bytes)
  return true
}

function keepText(capture: InspectionCapture, text: string, limit: number) {
  const length = Math.max(
    0,
    Math.min(limit, MAX_ENTRY_BYTES - capture.bytes) >> 1,
  )
  const value = text.slice(0, length)
  const truncated = value.length !== text.length
  capture.truncated ||= truncated
  const bytes = value.length * 2
  chargeText(capture, bytes)
  return { value, truncated }
}

/** Bound traversal and retained strings without cloning an arbitrarily large prompt. */
function inspectionJson(value: unknown): { text: string; truncated: boolean } {
  let remaining = 16_384
  let truncated = false
  const visit = (node: unknown, depth: number): unknown => {
    if (remaining <= 0 || depth > 16) {
      truncated = true
      return "[truncated]"
    }
    if (typeof node === "string") {
      const text = node.slice(0, remaining)
      remaining -= text.length
      truncated ||= text.length !== node.length
      return text
    }
    if (Array.isArray(node)) {
      const out: Array<unknown> = []
      for (const item of node) {
        if (out.length >= 256 || remaining <= 0) {
          truncated = true
          break
        }
        remaining -= 4
        out.push(visit(item, depth + 1))
      }
      return out
    }
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {}
      let count = 0
      for (const [key, item] of Object.entries(node)) {
        if (++count > 256 || remaining <= 0) {
          truncated = true
          break
        }
        remaining -= key.length + 4
        Object.defineProperty(out, key, {
          value: visit(item, depth + 1),
          enumerable: true,
        })
      }
      return out
    }
    return node
  }
  return { text: JSON.stringify(visit(value, 0)) ?? "null", truncated }
}

export function beginRedactionInspection(input: unknown): number | undefined {
  if (!getRedactionInspectionState().enabled) return undefined
  while (captures.size >= LIMIT) dropCapture(captures.keys().next().value!)
  const id = ++captureSequence
  const capture: InspectionCapture = {
    input: "",
    attempts: [],
    mappings: [],
    truncated: false,
    bytes: 0,
  }
  captures.set(id, capture)
  const rendered = inspectionJson(input)
  capture.input = keepText(capture, rendered.text, 32 * 1024).value
  capture.truncated ||= rendered.truncated
  return id
}

export function captureRedactionAttempt(
  id: number | undefined,
  upstream: RedactionUpstream,
  payload: unknown,
): number | undefined {
  if (!getRedactionInspectionState().enabled) return undefined
  const capture = id === undefined ? undefined : captures.get(id)
  if (!capture) return undefined
  if (capture.attempts.length >= 8) {
    capture.truncated = true
    return undefined
  }
  if (!keepFields(capture, [...Object.values(upstream), "adapter"]))
    return undefined
  const rendered = inspectionJson(payload)
  const text = keepText(capture, rendered.text, 32 * 1024)
  capture.attempts.push({
    upstream,
    stage: "adapter",
    body: text.value,
    truncated: text.truncated || rendered.truncated,
  })
  return capture.attempts.length - 1
}

export function captureRedactionHttp(
  id: number | undefined,
  index: number | undefined,
  body: string,
): void {
  if (!getRedactionInspectionState().enabled) return
  const capture = id === undefined ? undefined : captures.get(id)
  const attempt = index === undefined ? undefined : capture?.attempts[index]
  if (!capture || !attempt) return
  if (attempt.stage === "http") {
    if (capture.attempts.length >= 8) {
      capture.truncated = true
      return
    }
    if (!keepFields(capture, [...Object.values(attempt.upstream), "http"]))
      return
    const text = keepText(capture, body, 64 * 1024)
    capture.attempts.push({
      upstream: attempt.upstream,
      stage: "http",
      body: text.value,
      truncated: text.truncated,
    })
  } else {
    capture.bytes -= attempt.body.length * 2
    captureBytes -= attempt.body.length * 2
    const text = keepText(capture, body, 64 * 1024)
    Object.assign(attempt, {
      stage: "http",
      body: text.value,
      truncated: text.truncated,
    })
  }
}

export function redactionInspectionTokens(
  id: number | undefined,
): Array<string> {
  const capture = id === undefined ? undefined : captures.get(id)
  if (!capture) return []
  return [
    ...new Set(
      capture.attempts.flatMap((attempt) =>
        [
          ...attempt.body.matchAll(
            /\{\{(?:SECRET|HOME|WORD)_[a-f0-9]{32}\}\}/g,
          ),
        ].map((match) => match[0]),
      ),
    ),
  ].slice(0, 100)
}

export function finishRedactionInspection(
  id: number | undefined,
  mappings: Array<InspectionMapping>,
): void {
  if (!getRedactionInspectionState().enabled) return
  const capture = id === undefined ? undefined : captures.get(id)
  if (!capture) return
  for (const mapping of mappings) {
    if (
      !keepFields(capture, [mapping.placeholder, mapping.kind, mapping.source])
    )
      break
    const text = keepText(capture, mapping.value, 4096)
    capture.mappings.push({ ...mapping, value: text.value })
  }
}

export function getRedactionInspection(id: number, reveal = false) {
  getRedactionInspectionState()
  const entry = recent.find((entry) => entry.id === id)
  const capture =
    entry?.captureId === undefined ? undefined : captures.get(entry.captureId)
  if (!capture) return undefined
  return {
    id,
    input: reveal ? capture.input : null,
    attempts: structuredClone(capture.attempts),
    mappings: capture.mappings.map(({ value, ...mapping }) =>
      reveal ? { ...mapping, value } : mapping,
    ),
    truncated: capture.truncated,
  }
}

/** Lists contain only routing metadata and counters. Content requires a separate explicit read. */
export function recordRedactionDiagnostics(
  value: RedactionDiagnostics,
  route: { client: string; upstreams: Array<RedactionUpstream> } = {
    client: "Unknown client",
    upstreams: [],
  },
  captureId?: number,
): void {
  recent.unshift({
    ...structuredClone(value),
    id: ++sequence,
    timestamp: Date.now(),
    ...structuredClone(route),
    captureId,
  })
  if (recent.length > LIMIT) {
    const expired = recent.pop()!
    if (expired.captureId !== undefined) dropCapture(expired.captureId)
  }
}

export function getRedactionDiagnostics() {
  const inspection = getRedactionInspectionState()
  return {
    limit: LIMIT,
    inspection,
    entries: recent.map(({ captureId, ...entry }) => ({
      ...structuredClone(entry),
      contentAvailable: captureId !== undefined && captures.has(captureId),
    })),
  }
}
