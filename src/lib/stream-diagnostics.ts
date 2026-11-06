import type { Context } from "hono"

import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

import { asRecord } from "~/lib/json-shape"
import { logger } from "~/lib/logger"
import { createDumpSanitizer } from "~/lib/request-dump-sanitizer"
import { inspectDiagnosticEvent } from "~/lib/stream-diagnostic-events"
import { saveStreamIncident } from "~/lib/stream-diagnostics-store"
import { getSystemSettings } from "~/lib/system-config"

type Stage = "upstream-wire" | "upstream-adapter" | "downstream"
interface DiagnosticScope {
  recorder: StreamDiagnostics
  attempt: number
}
interface CapturedValue {
  text: string
  bytes: number
  truncated: boolean
}
interface Channel {
  kind: string
  tail: string
  checkedAt: number
  bytes: number
  tool: string
  toolTruncated: boolean
}
interface Observation {
  stage: Stage
  attempt: number
  events: number
  bytes: number
  textBytes: number
  reasoningBytes: number
  hash: ReturnType<typeof createHash>
  textHash: ReturnType<typeof createHash>
  reasoningHash: ReturnType<typeof createHash>
  frames: Array<{ atMs: number; eventName?: string; wireData: CapturedValue }>
  frameBytes: number
  droppedFrames: number
  terminal: boolean
  incomplete: boolean
  sensitive: boolean
  channels: Map<string, Channel>
}

const MAX_ACTIVE = 16
const MAX_ATTEMPTS = 8
const MAX_CAPTURE_BYTES = 64 * 1024
const MAX_REQUEST_BYTES = 96 * 1024
const MAX_EVENT_BYTES = 192 * 1024
const MAX_FRAMES = 128
const MAX_CHANNELS = 4
const MAX_TAIL_CHARS = 4096
const MAX_TOOL_CHARS = 16 * 1024
const MAX_LIFETIME_MS = 15 * 60_000
const active = new Set<StreamDiagnostics>()
const contexts = new WeakMap<Context, StreamDiagnostics>()
const scope = new AsyncLocalStorage<DiagnosticScope>()

function cap(text: string, limit = MAX_CAPTURE_BYTES): CapturedValue {
  const bytes = Buffer.byteLength(text)
  return {
    text:
      bytes > limit ?
        Buffer.from(text)
          .subarray(0, limit)
          .toString("utf8")
          .replace(/\uFFFD$/, "")
      : text,
    bytes,
    truncated: bytes > limit,
  }
}

/** Heuristic only; a repeated table/code fragment must never change forwarding. */
function isLoop(tail: string): boolean {
  for (let size = 24; size <= 512; size++) {
    const repeats = Math.max(8, Math.ceil(512 / size))
    if (size * repeats > tail.length) continue
    const phrase = tail.slice(-size)
    if (phrase !== tail.slice(-size * 2, -size)) continue
    if (new Set(phrase.trim()).size < 6) continue
    let count = 2
    while (
      count < repeats
      && phrase === tail.slice(-size * (count + 1), -size * count)
    )
      count++
    if (count === repeats) return true
  }
  return false
}

/** Bounded flight recorder. No disk write on a normal turn, independent of dump. */
export class StreamDiagnostics {
  readonly requestId: string
  readonly path: string
  private readonly startedAt = Date.now()
  private readonly metadataOnly = getSystemSettings().redaction.enabled
  private readonly observations = new Map<string, Observation>()
  private readonly requests: Array<{
    stage: string
    attempt: number
    body: CapturedValue
    metadata?: unknown
  }> = []
  private readonly reasons = new Set<string>()
  private readonly secrets = new Set<string>()
  private readonly timer?: ReturnType<typeof setTimeout>
  private readonly enabled: boolean
  private closed = false
  private attempts = 0
  private requestBytes = 0
  private initialSaved = false
  private pending = Promise.resolve()

  constructor(requestId: string, path: string) {
    this.requestId = requestId
    this.path = path
    this.enabled =
      active.size < MAX_ACTIVE && process.env.STREAM_DIAGNOSTICS !== "0"
    if (!this.enabled) return
    active.add(this)
    this.timer = setTimeout(() => {
      if (this.observations.size) this.reasons.add("observation_timeout")
      void this.finish()
    }, MAX_LIFETIME_MS)
    this.timer.unref()
  }

  request(
    stage: string,
    value: unknown,
    attempt = 0,
    metadata?: unknown,
  ): void {
    if (
      !this.enabled
      || this.closed
      || this.requests.length >= 1 + MAX_ATTEMPTS * 2
      || this.requestBytes >= MAX_REQUEST_BYTES
    )
      return
    try {
      if (this.metadataOnly) {
        this.requests.push({
          stage,
          attempt,
          body: {
            text: "[omitted: redaction enabled]",
            bytes: 0,
            truncated: true,
          },
          metadata,
        })
        return
      }
      // Sanitize before capping: a truncated JSON body is not safe to parse later.
      const serialized = JSON.stringify(value)
      if (!serialized) return
      const sanitizer = createDumpSanitizer([serialized])
      const body = cap(
        sanitizer.json(serialized),
        Math.min(16 * 1024, MAX_REQUEST_BYTES - this.requestBytes),
      )
      this.requestBytes += Buffer.byteLength(body.text)
      this.requests.push({ stage, attempt, body, metadata })
    } catch {
      logger.debug("[stream-diagnostics] request capture unavailable", {
        requestId: this.requestId,
      })
    }
  }

  attempt(metadata: unknown, payload: unknown, credential?: string): number {
    if (!this.enabled || this.closed || this.attempts >= MAX_ATTEMPTS) return 0
    const attempt = ++this.attempts
    if (credential && credential.length >= 4) this.secrets.add(credential)
    this.request("adapter-input", payload, attempt, metadata)
    return attempt
  }

  observe(stage: Stage, value: unknown, attempt = 0): void {
    if (
      !this.enabled
      || this.closed
      || (stage !== "downstream" && (!attempt || attempt > this.attempts))
    )
      return
    try {
      this.observeEvent(stage, value, attempt)
    } catch {
      // Observation is best-effort and must not break or consume the real stream.
      logger.debug("[stream-diagnostics] observation unavailable", {
        requestId: this.requestId,
      })
    }
  }

  private observeEvent(stage: Stage, value: unknown, attempt: number): void {
    const key = `${stage}:${attempt}`
    let observation = this.observations.get(key)
    if (!observation) {
      observation = {
        stage,
        attempt,
        events: 0,
        bytes: 0,
        textBytes: 0,
        reasoningBytes: 0,
        hash: createHash("sha256"),
        textHash: createHash("sha256"),
        reasoningHash: createHash("sha256"),
        frames: [],
        frameBytes: 0,
        droppedFrames: 0,
        terminal: false,
        incomplete: false,
        sensitive: false,
        channels: new Map(),
      }
      this.observations.set(key, observation)
    }
    const envelope = asRecord(value)
    const data =
      typeof envelope?.data === "string" ? envelope.data
      : typeof value === "string" ? value
      : JSON.stringify(value)
    if (!data) return
    observation.events++
    observation.bytes += Buffer.byteLength(data)
    observation.hash.update(data)
    const wireData = cap(data, 16 * 1024)
    const eventName =
      typeof envelope?.event === "string" ?
        envelope.event.slice(0, 128)
      : undefined
    if (!this.metadataOnly) {
      observation.frames.push({
        atMs: Date.now() - this.startedAt,
        eventName,
        wireData,
      })
      observation.frameBytes += Buffer.byteLength(wireData.text)
    }
    while (
      observation.frameBytes > MAX_CAPTURE_BYTES
      || observation.frames.length > MAX_FRAMES
    ) {
      observation.frameBytes -= Buffer.byteLength(
        observation.frames.shift()!.wireData.text,
      )
      observation.droppedFrames++
    }
    let totalBytes = [...this.observations.values()].reduce(
      (sum, entry) => sum + entry.frameBytes,
      0,
    )
    for (const entry of this.observations.values()) {
      while (totalBytes > MAX_EVENT_BYTES && entry.frames.length) {
        const bytes = Buffer.byteLength(entry.frames.shift()!.wireData.text)
        entry.frameBytes -= bytes
        totalBytes -= bytes
        entry.droppedFrames++
      }
    }
    if (data === "[DONE]") {
      observation.terminal = true
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      this.flag("malformed_json")
      return
    }
    const inspected = inspectDiagnosticEvent(parsed)
    observation.terminal ||= inspected.terminal
    observation.incomplete ||= inspected.incomplete
    if (inspected.failed) this.flag("error_event")
    for (const text of inspected.texts) {
      if (text.kind === "text") {
        observation.textBytes += Buffer.byteLength(text.text)
        observation.textHash.update(text.text)
      }
      if (text.kind === "reasoning") {
        observation.reasoningBytes += Buffer.byteLength(text.text)
        observation.reasoningHash.update(text.text)
      }
      const id = `${text.kind}:${text.channel}`
      let channel = observation.channels.get(id)
      if (!channel && observation.channels.size < MAX_CHANNELS) {
        channel = {
          kind: text.kind,
          tail: "",
          checkedAt: 0,
          bytes: 0,
          tool: "",
          toolTruncated: false,
        }
        observation.channels.set(id, channel)
      }
      if (!channel) continue
      channel.bytes += text.text.length
      channel.tail = (channel.tail + text.text).slice(-MAX_TAIL_CHARS)
      // Credentials can be split across arbitrary deltas. In that case omit
      // this stream's frames rather than leaking individually harmless pieces.
      if (!observation.sensitive) {
        const sanitizer = createDumpSanitizer(
          [...this.secrets].map((token) => JSON.stringify({ token })),
        )
        observation.sensitive = sanitizer.text(channel.tail) !== channel.tail
      }
      if (text.kind === "tool") {
        channel.toolTruncated ||=
          channel.tool.length + text.text.length > MAX_TOOL_CHARS
        channel.tool = (channel.tool + text.text).slice(0, MAX_TOOL_CHARS)
      } else if (channel.bytes - channel.checkedAt >= 128) {
        channel.checkedAt = channel.bytes
        if (isLoop(channel.tail)) this.flag(`repetition:${stage}`)
      }
    }
  }

  private flag(reason: string): void {
    this.reasons.add(reason)
    // Freeze evidence immediately; a loop may never reach a terminal event.
    if (!this.initialSaved) {
      this.initialSaved = true
      this.persist("triggered")
    }
  }

  private persist(status: string): void {
    const raw = JSON.stringify({
      requestId: this.requestId,
      createdAt: this.startedAt,
      path: this.path,
      status,
      contentOmittedForRedaction: this.metadataOnly,
      reasons: [...this.reasons],
      requestsTruncated:
        this.requestBytes >= MAX_REQUEST_BYTES
        || this.requests.some((request) => request.body.truncated),
      requests: this.requests,
      streams: [...this.observations.values()].map((entry) => ({
        stage: entry.stage,
        attempt: entry.attempt,
        events: entry.events,
        bytes: entry.bytes,
        textBytes: entry.textBytes,
        reasoningBytes: entry.reasoningBytes,
        hash: entry.hash.copy().digest("hex"),
        textHash: entry.textHash.copy().digest("hex"),
        reasoningHash: entry.reasoningHash.copy().digest("hex"),
        terminal: entry.terminal,
        incomplete: entry.incomplete,
        droppedFrames: entry.droppedFrames,
        framesOmittedForSecrets: entry.sensitive,
        frames: entry.sensitive ? [] : entry.frames,
      })),
    })
    const sanitizer = createDumpSanitizer([
      raw,
      ...[...this.secrets].map((token) => JSON.stringify({ token })),
    ])
    const record = JSON.parse(sanitizer.json(raw)) as {
      requestId: string
      createdAt: number
    }
    const saving =
      status === "triggered" ?
        saveStreamIncident(record)
      : this.pending.then(() => saveStreamIncident(record))
    this.pending = saving.catch(() => {
      logger.warn("[stream-diagnostics] could not save incident", {
        requestId: this.requestId,
      })
    })
    logger.warn("[stream-diagnostics] anomaly captured", {
      requestId: this.requestId,
      reasons: [...this.reasons],
    })
  }

  finish(outcome = "completed"): Promise<void> {
    if (!this.enabled || this.closed) return this.pending
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    active.delete(this)
    for (const entry of this.observations.values()) {
      if (
        entry.stage === "downstream"
        && !entry.terminal
        && entry.events
        && outcome !== "cancelled"
      )
        this.reasons.add("missing_terminal")
      if (outcome !== "cancelled" && entry.terminal && !entry.incomplete) {
        for (const channel of entry.channels.values()) {
          if (channel.kind !== "tool" || channel.toolTruncated || !channel.tool)
            continue
          try {
            JSON.parse(channel.tool)
          } catch {
            this.reasons.add("malformed_tool_arguments")
          }
        }
      }
    }
    if (this.observations.size && outcome === "failed")
      this.reasons.add("stream_failed")
    const upstream = this.observations.get("upstream-adapter:1")
    const downstream = this.observations.get("downstream:0")
    if (this.attempts === 1 && upstream?.terminal && downstream?.terminal) {
      const before = upstream.textBytes + upstream.reasoningBytes
      const after = downstream.textBytes + downstream.reasoningBytes
      // Heuristic, not a verdict: valid snapshot repair may also expand output.
      if (before > 0 && after >= before * 2 && after - before >= 512)
        this.reasons.add("output_expansion")
    }
    if (this.reasons.size) {
      try {
        this.persist(outcome)
      } catch {
        logger.warn("[stream-diagnostics] could not prepare incident", {
          requestId: this.requestId,
        })
      }
    }
    this.observations.clear()
    this.requests.length = 0
    this.secrets.clear()
    return this.pending
  }
}

export function beginStreamDiagnostics(
  c: Context | undefined,
  payload: unknown,
): StreamDiagnostics | undefined {
  if (!c) return undefined
  const requestId = c.get("requestId") as string | undefined
  if (!requestId) return undefined
  let recorder = contexts.get(c)
  if (!recorder || recorder.requestId !== requestId) {
    recorder = new StreamDiagnostics(requestId, c.req.path)
    contexts.set(c, recorder)
    recorder.request("dispatch-input", payload)
  }
  return recorder
}

export function observeDownstreamEvent(
  c: Context | undefined,
  data: string,
  event?: string,
): void {
  if (c) contexts.get(c)?.observe("downstream", { data, event })
}

export function finishStreamDiagnostics(c: Context, outcome?: string): void {
  const recorder = contexts.get(c)
  contexts.delete(c)
  void recorder?.finish(outcome)
}

export function currentStreamDiagnosticScope(): DiagnosticScope | undefined {
  return scope.getStore()
}

export function observeDiagnosticWire(value: unknown): void {
  const current = scope.getStore()
  current?.recorder.observe("upstream-wire", value, current.attempt)
}

export function observeDiagnosticRequest(body: string): void {
  const current = scope.getStore()
  if (!current?.attempt) return
  try {
    current.recorder.request(
      "transport-input",
      JSON.parse(body),
      current.attempt,
    )
  } catch {
    logger.debug("[stream-diagnostics] transport capture unavailable")
  }
}

export async function withStreamDiagnosticAttempt<
  P extends {
    ctx?: { c?: Context }
    payload: unknown
    connection: { id: string; protocol: string }
    credential?: { value: string }
  },
  R extends { response: unknown },
>(params: P, call: () => Promise<R>): Promise<R> {
  const recorder = beginStreamDiagnostics(params.ctx?.c, params.payload)
  if (!recorder) return call()
  const attempt = recorder.attempt(
    {
      connectionId: params.connection.id,
      protocol: params.connection.protocol,
    },
    params.payload,
    params.credential?.value,
  )
  const current = { recorder, attempt }
  if (!attempt) return call()
  const result = await scope.run(current, call)
  const response = result.response
  if (
    !response
    || typeof response !== "object"
    || !(Symbol.asyncIterator in response)
  )
    return result
  const iterable = response as AsyncIterable<unknown>
  return {
    ...result,
    response: {
      async *[Symbol.asyncIterator]() {
        const iterator = scope.run(current, () =>
          iterable[Symbol.asyncIterator](),
        )
        let completed = false
        try {
          while (true) {
            const next = await scope.run(current, () => iterator.next())
            if (next.done) {
              completed = true
              return
            }
            recorder.observe("upstream-adapter", next.value, attempt)
            yield next.value
          }
        } finally {
          if (!completed) await scope.run(current, () => iterator.return?.())
        }
      },
    },
  }
}
