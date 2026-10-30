import { appendRedactionHistory } from "~/lib/redaction/history"
import {
  redactionExcerpts,
  type RedactionExcerpt,
} from "~/lib/redaction/excerpts"
import type { RedactionMatch } from "~/lib/redaction/rules"
import { tokenPattern } from "~/lib/redaction/token"

export interface RedactionDiagnostics {
  detected: number
  detectedByKind: Record<RedactionMatch["kind"], number>
  warnedByKind: Record<RedactionMatch["kind"], number>
  blockedByKind: Record<RedactionMatch["kind"], number>
  blockedCount: number
  /** Distinct values replaced by a placeholder. */
  total: number
  byKind: Record<RedactionMatch["kind"], number>
  byLabel: Partial<Record<RedactionMatch["label"], number>>
  bySource: Record<RedactionMatch["source"], number>
  /** Distinct values a `warn` action sent as written. */
  warned: number
  /** Values a `block` action refused, by kind and hint; never the value. */
  blocked: Array<{ label: RedactionMatch["label"]; hint: string }>
  maskingMs: number
  restored: number
}

export function emptyRedactionDiagnostics(): RedactionDiagnostics {
  return {
    detected: 0,
    detectedByKind: { SECRET: 0, HOME: 0, WORD: 0, PERSONAL: 0 },
    warnedByKind: { SECRET: 0, HOME: 0, WORD: 0, PERSONAL: 0 },
    blockedByKind: { SECRET: 0, HOME: 0, WORD: 0, PERSONAL: 0 },
    blockedCount: 0,
    total: 0,
    byKind: { SECRET: 0, HOME: 0, WORD: 0, PERSONAL: 0 },
    byLabel: {},
    bySource: { builtin: 0, word: 0, homePrefix: 0, field: 0, known: 0 },
    warned: 0,
    blocked: [],
    maskingMs: 0,
    restored: 0,
  }
}

interface RecentRedaction extends RedactionDiagnostics {
  status: RedactionRecordStatus
  id: number
  timestamp: number
  client: string
  upstreams: Array<RedactionUpstream>
  captureId?: number
  attempts: Array<RedactionAttempt>
  attemptsTruncated: boolean
}

export interface RedactionAttempt {
  upstream: RedactionUpstream
  status: "running" | "returned" | "failed"
  bodies: Array<{
    places: number
    status: "prepared" | "response" | "failed"
    httpStatus?: number
  }>
  truncated: boolean
}

const LIMIT = 100
// User agents are caller-controlled, so the lane maps need a ceiling. Past it,
// unknown names are dropped rather than displacing counted lanes: rotating fake
// names must not be able to evict a real client or upstream from the graph.
const LANE_LIMIT = 200
let sequence = 0
// Every record ever created in this process, including those the recent
// window has since evicted. The list stays bounded; the totals do not.
let totalRequests = 0
const clientTotals = new Map<string, RedactionLane>()
const upstreamTotals = new Map<string, RedactionLane>()
const recent: Array<RecentRedaction> = []
export type RedactionRecordStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
type RedactionRoute = {
  client: string
  upstreams: Array<RedactionUpstream>
  attempts?: Array<RedactionAttempt>
  attemptsTruncated?: boolean
  startedAt?: number
}
const listeners = new Set<() => void>()

export function subscribeRedactionDiagnostics(
  listener: () => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notifyDiagnostics(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* Diagnostics must not interrupt a request. */
    }
  }
}

export interface RedactionUpstream {
  id: string
  name: string
  protocol: string
  model: string
}

/** Lifetime request count for one client or upstream lane. */
interface RedactionLane {
  id: string
  name: string
  count: number
}

interface InspectionMapping {
  placeholder: string
  kind: RedactionMatch["kind"]
  label: RedactionMatch["label"]
  source: RedactionMatch["source"]
  value: string
  truncated?: boolean
  originalLength?: number
}

interface InspectionAttempt {
  upstream: RedactionUpstream
  stage: "http" | "adapter"
  body: string
  excerpts: Array<RedactionExcerpt>
  truncated: boolean
}

interface InspectionCapture {
  version: number
  mappingBytes: number
  attempts: Array<InspectionAttempt>
  mappings: Array<InspectionMapping>
  truncated: boolean
  bytes: number
}

const TTL_MS = 5 * 60_000
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ENTRY_BYTES = 128 * 1024
const MAX_MAPPING_BYTES = 32 * 1024
const MAX_CONTENT_BYTES = MAX_ENTRY_BYTES - MAX_MAPPING_BYTES
const captures = new Map<number, InspectionCapture>()
type ContentState =
  | "available"
  | "not_collected"
  | "cleared"
  | "disabled"
  | "expired"
  | "evicted"
const captureReasons = new Map<number, ContentState>()
let captureSequence = 0
let inspectionEnabled = true
let inspectionExpiresAt: number | null = null
let inspectionTimer: ReturnType<typeof setTimeout> | undefined
let captureBytes = 0

export function clearRedactionInspection(
  reason: ContentState = "cleared",
): void {
  for (const id of captures.keys()) rememberCaptureReason(id, reason)
  captures.clear()
  captureBytes = 0
  notifyDiagnostics()
}

function rememberCaptureReason(id: number, reason: ContentState): void {
  captureReasons.set(id, reason)
  while (captureReasons.size > LIMIT * 2)
    captureReasons.delete(captureReasons.keys().next().value!)
}

export function getRedactionInspectionState() {
  if (inspectionExpiresAt !== null && inspectionExpiresAt <= Date.now()) {
    inspectionExpiresAt = null
    inspectionEnabled = false
    clearRedactionInspection("expired")
  }
  return {
    enabled: inspectionEnabled,
    expiresAt: inspectionExpiresAt,
    ttlMs: TTL_MS,
    maxBytes: MAX_BYTES,
    maxEntryBytes: MAX_ENTRY_BYTES,
    bytes: captureBytes,
    mode:
      !inspectionEnabled ? "off"
      : inspectionExpiresAt === null ? "continuous"
      : "temporary",
    retainsClientInput: false,
    retainsMappingValues: true,
  }
}

/** Continuous bounded evidence is the default; temporary collection is explicit. */
export function setRedactionInspection(
  enabled: boolean,
  mode: "continuous" | "temporary" = "continuous",
) {
  clearTimeout(inspectionTimer)
  clearRedactionInspection(enabled ? "cleared" : "disabled")
  inspectionEnabled = enabled
  inspectionExpiresAt =
    enabled && mode === "temporary" ? Date.now() + TTL_MS : null
  if (inspectionExpiresAt !== null)
    inspectionTimer = setTimeout(() => {
      inspectionExpiresAt = null
      inspectionEnabled = false
      clearRedactionInspection("expired")
    }, TTL_MS).unref()
  return getRedactionInspectionState()
}

function dropCapture(id: number): void {
  const capture = captures.get(id)
  if (capture) captureBytes -= capture.bytes
  captures.delete(id)
  rememberCaptureReason(id, "evicted")
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

/** Prefer hit evidence to old body prefixes within the existing entry budget. */
function keepContentFields(
  capture: InspectionCapture,
  fields: Array<string>,
): boolean {
  const needed = fields.reduce((sum, text) => sum + text.length * 2, 0)
  while (MAX_CONTENT_BYTES - (capture.bytes - capture.mappingBytes) < needed) {
    const old = capture.attempts.find((attempt) => attempt.body.length > 0)
    if (!old) {
      capture.truncated = true
      return false
    }
    const bytes = old.body.length * 2
    capture.bytes -= bytes
    captureBytes -= bytes
    old.body = ""
    old.truncated = true
    capture.truncated = true
    capture.version++
  }
  return keepFields(capture, fields)
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

function captureAttemptText(
  capture: InspectionCapture,
  value: unknown,
  rendered: { text: string; truncated: boolean },
  limit: number,
) {
  const excerpts: Array<RedactionExcerpt> = []
  const selected = redactionExcerpts(value)
  capture.truncated ||= selected.truncated
  for (const excerpt of selected.items) {
    if (!keepContentFields(capture, [excerpt.path, excerpt.text])) break
    excerpts.push(excerpt)
  }
  const kept = keepText(
    capture,
    rendered.text,
    Math.max(
      0,
      Math.min(
        limit,
        MAX_CONTENT_BYTES - (capture.bytes - capture.mappingBytes),
      ),
    ),
  )
  const truncated = kept.truncated || rendered.truncated
  capture.truncated ||= truncated
  return { body: kept.value, excerpts, truncated }
}

export function beginRedactionInspection(_input?: unknown): number | undefined {
  if (!getRedactionInspectionState().enabled) return undefined
  while (captures.size >= LIMIT) dropCapture(captures.keys().next().value!)
  const id = ++captureSequence
  const capture: InspectionCapture = {
    version: 1,
    mappingBytes: 0,
    attempts: [],
    mappings: [],
    truncated: false,
    bytes: 0,
  }
  captures.set(id, capture)
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
  if (!keepContentFields(capture, [...Object.values(upstream), "adapter"]))
    return undefined
  const rendered = inspectionJson(payload)
  capture.attempts.push({
    upstream,
    stage: "adapter",
    ...captureAttemptText(capture, payload, rendered, 32 * 1024),
  })
  capture.version++
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
  capture.version++
  if (attempt.stage === "http") {
    if (capture.attempts.length >= 8) {
      capture.truncated = true
      return
    }
    if (
      !keepContentFields(capture, [...Object.values(attempt.upstream), "http"])
    )
      return
    capture.attempts.push({
      upstream: attempt.upstream,
      stage: "http",
      ...captureAttemptText(
        capture,
        body,
        { text: body, truncated: false },
        64 * 1024,
      ),
    })
  } else {
    const bytes =
      2
      * (attempt.body.length
        + attempt.stage.length
        - "http".length
        + attempt.excerpts.reduce(
          (sum, excerpt) => sum + excerpt.path.length + excerpt.text.length,
          0,
        ))
    capture.bytes -= bytes
    captureBytes -= bytes
    attempt.body = ""
    attempt.excerpts = []
    Object.assign(attempt, {
      stage: "http",
      ...captureAttemptText(
        capture,
        body,
        { text: body, truncated: false },
        64 * 1024,
      ),
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
          attempt.body,
          ...attempt.excerpts.map((excerpt) => excerpt.text),
        ].flatMap((text) =>
          [...text.matchAll(tokenPattern())].map((match) => match[0]),
        ),
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
  if (
    mappings.length === capture.mappings.length
    && mappings.every((mapping, index) => {
      const kept = capture.mappings[index]
      return (
        mapping.placeholder === kept.placeholder
        && mapping.source === kept.source
        && mapping.value.length === kept.originalLength
        && mapping.value.startsWith(kept.value)
      )
    })
  )
    return
  const previousBytes = capture.mappingBytes
  capture.bytes -= previousBytes
  captureBytes -= previousBytes
  capture.mappings = []
  capture.mappingBytes = 0
  capture.version++
  const before = capture.bytes
  let metadataRemaining = mappings.reduce(
    (sum, mapping) =>
      sum
      + 2
        * (mapping.placeholder.length
          + mapping.kind.length
          + mapping.label.length
          + mapping.source.length),
    0,
  )
  for (const mapping of mappings) {
    if (
      !keepFields(capture, [
        mapping.placeholder,
        mapping.kind,
        mapping.label,
        mapping.source,
      ])
    )
      break
    metadataRemaining -=
      2
      * (mapping.placeholder.length
        + mapping.kind.length
        + mapping.label.length
        + mapping.source.length)
    const limit = Math.max(
      0,
      Math.min(
        4096,
        MAX_MAPPING_BYTES - (capture.bytes - before) - metadataRemaining,
      ),
    )
    const text = keepText(capture, mapping.value, limit)
    capture.mappings.push({
      ...mapping,
      value: text.value,
      truncated: text.truncated,
      originalLength: mapping.value.length,
    })
  }
  capture.mappingBytes = capture.bytes - before
}

export function getRedactionInspection(id: number, reveal = false) {
  getRedactionInspectionState()
  const entry = recent.find((entry) => entry.id === id)
  const capture =
    entry?.captureId === undefined ? undefined : captures.get(entry.captureId)
  if (!capture) return undefined
  return {
    id,
    version: capture.version,
    input: null,
    attempts: structuredClone(capture.attempts),
    mappings: capture.mappings.map(({ value, ...mapping }) =>
      reveal ? { ...mapping, value } : mapping,
    ),
    truncated: capture.truncated,
  }
}

/**
 * Counts one request in each distinct lane. A request that names the same
 * client or upstream twice counts once, matching the lanes the page draws.
 * Past the ceiling new names are ignored rather than displacing counted
 * ones: user agents are caller-controlled, so a rotation of fake names must
 * not be able to evict a real client from the graph.
 */
function countLanes(
  totals: Map<string, RedactionLane>,
  lanes: Array<{ id: string; name: string }>,
): void {
  const seen = new Set<string>()
  for (const lane of lanes) {
    const id = lane.id || ""
    if (seen.has(id)) continue
    seen.add(id)
    const existing = totals.get(id)
    if (existing) {
      existing.count++
      if (lane.name) existing.name = lane.name
    } else if (totals.size < LANE_LIMIT) {
      totals.set(id, { id, name: lane.name || id, count: 1 })
    }
  }
}

function laneTotals(totals: Map<string, RedactionLane>): Array<RedactionLane> {
  return [...totals.values()]
    .map((lane) => ({ ...lane }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
}

/** Lists contain only routing metadata and counters. Content requires a separate explicit read. */
export function recordRedactionDiagnostics(
  value: RedactionDiagnostics,
  route: RedactionRoute = {
    client: "Unknown client",
    upstreams: [],
  },
  captureId?: number,
  status: RedactionRecordStatus = "completed",
): number {
  const timestamp = route.startedAt ?? Date.now()
  if (status !== "in_progress") appendRedactionHistory(value, route, timestamp)
  const id = ++sequence
  totalRequests++
  countLanes(clientTotals, [{ id: route.client, name: route.client }])
  countLanes(
    upstreamTotals,
    route.upstreams.length ?
      route.upstreams.map(({ id, name }) => ({ id, name }))
    : [{ id: "", name: "" }],
  )
  recent.unshift({
    ...structuredClone(value),
    id,
    status,
    timestamp,
    client: route.client,
    upstreams: structuredClone(route.upstreams),
    attempts: structuredClone(route.attempts ?? []),
    attemptsTruncated: route.attemptsTruncated ?? false,
    captureId,
  })
  if (recent.length > LIMIT) {
    const expired = recent.pop()!
    if (expired.captureId !== undefined) dropCapture(expired.captureId)
  }
  notifyDiagnostics()
  return id
}

/** Update the same live record; only terminal updates enter durable history. */
export function updateRedactionDiagnostics(
  id: number,
  value: RedactionDiagnostics,
  route: RedactionRoute,
  status: RedactionRecordStatus = "in_progress",
): void {
  const entry = recent.find((item) => item.id === id)
  if (entry)
    Object.assign(entry, structuredClone(value), {
      client: route.client,
      upstreams: structuredClone(route.upstreams),
      attempts: structuredClone(route.attempts ?? []),
      attemptsTruncated: route.attemptsTruncated ?? false,
      status,
    })
  if (status !== "in_progress")
    appendRedactionHistory(value, route, route.startedAt ?? entry?.timestamp)
  notifyDiagnostics()
}

export function getRedactionDiagnostics() {
  const inspection = getRedactionInspectionState()
  return {
    limit: LIMIT,
    totalRequests,
    lanes: {
      clients: laneTotals(clientTotals),
      upstreams: laneTotals(upstreamTotals),
    },
    inspection,
    entries: recent.map(({ captureId, ...entry }) => ({
      ...structuredClone(entry),
      contentAvailable: captureId !== undefined && captures.has(captureId),
      contentVersion:
        captureId === undefined ? 0 : (captures.get(captureId)?.version ?? 0),
      contentState:
        captureId === undefined ? "not_collected"
        : captures.has(captureId) ? "available"
        : (captureReasons.get(captureId) ?? "evicted"),
    })),
  }
}
