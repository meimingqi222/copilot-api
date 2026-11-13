type JsonObject = Record<string, unknown>

export function jsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as JsonObject)
    : undefined
}

interface StreamState {
  id?: string
  dropped: boolean
  open: boolean
  limits?: JsonObject
}
interface WholeMessage {
  message: JsonObject
  blocks: Array<JsonObject>
  updated: number
}

function replyLimits(value: unknown): JsonObject | undefined {
  const headers = jsonObject(value)
  if (!headers) return
  const unifiedWindows: JsonObject = {}
  for (const [name, key] of [
    ["5h", "five_hour"],
    ["7d", "seven_day"],
    ["7d_oi", "seven_day_overage_included"],
  ]) {
    const used = headers[`anthropic-ratelimit-unified-${name}-utilization`]
    const reset = headers[`anthropic-ratelimit-unified-${name}-reset`]
    if (
      typeof used !== "string"
      || !used.trim()
      || typeof reset !== "string"
      || !reset.trim()
      || !Number.isFinite(Number(used))
      || !Number.isFinite(Number(reset))
    )
      continue
    unifiedWindows[key] = {
      utilization: Number(used),
      resetsAt: Math.round(Number(reset)),
    }
  }
  if (!Object.keys(unifiedWindows).length) return
  const status = headers["anthropic-ratelimit-unified-status"]
  return { unifiedWindows, ...(typeof status === "string" ? { status } : {}) }
}

/** Merge tapped SSE with persisted messages without emitting either reply twice. */
export class ClaudeTuiEvents {
  private readonly streams = new Map<number, StreamState>()
  private readonly streamed = new Set<string>()
  private readonly whole = new Set<string>()
  private readonly completed = new Set<string>()
  private pending: WholeMessage | undefined
  private fallback:
    | { id: string; message: JsonObject; index: number }
    | undefined
  private endingAt: number | undefined
  private failed = false
  private busy = false
  private stopReason: unknown
  private limitsTold = 0
  private pendingLimits: { stream: number; info: JsonObject } | undefined
  private readonly emit: (value: unknown) => void
  constructor(emit: (value: unknown) => void) {
    this.emit = emit
  }

  tap(value: unknown): void {
    const row = jsonObject(value)
    if (!row || typeof row.s !== "number") return
    if (row.open) {
      this.streams.set(row.s, {
        dropped: false,
        open: true,
        limits: replyLimits(row.h),
      })
      return
    }
    const stream = this.streams.get(row.s)
    if (!stream) return
    const event = jsonObject(row.e)
    if (event) {
      if (event.type === "message_start") {
        const message = jsonObject(event.message)
        if (typeof message?.id === "string") {
          stream.id = message.id
          stream.dropped =
            this.whole.has(message.id) || this.completed.has(message.id)
          if (!stream.dropped) this.streamed.add(message.id)
          if (!stream.dropped && stream.limits) {
            this.tellLimits(row.s, stream.limits)
            stream.limits = undefined
          }
        }
      }
      if (!stream.dropped) this.wire(event)
    }
    if (row.end) {
      stream.open = false
      if (
        stream.limits
        && row.s > this.limitsTold
        && row.s >= (this.pendingLimits?.stream ?? 0)
      )
        this.pendingLimits = { stream: row.s, info: stream.limits }
      stream.limits = undefined
      if (!this.busy && stream.id && this.completed.has(stream.id))
        this.settleLimits()
      if (row.end === "cut" && !stream.dropped)
        this.error("Claude Code interactive stream was interrupted")
    }
  }

  transcript(value: unknown): void {
    const row = jsonObject(value)
    if (!row || row.isSidechain) return
    const message = jsonObject(row.message)
    if (row.type === "user") {
      if (!row.isMeta && !row.toolUseResult) {
        this.busy = true
        this.failed = false
      }
      return
    }
    if (row.type === "assistant" && message) {
      if (row.isApiErrorMessage || message.model === "<synthetic>") {
        const info = jsonObject(row.apiErrorParams)?.rate_limit_info
        if (info) {
          // A synthetic error is newer than the reply headers already read.
          this.settleLimits()
          this.limitsTold = Math.max(this.limitsTold, ...this.streams.keys())
          for (const stream of this.streams.values()) stream.limits = undefined
          this.emit({ type: "rate_limit_event", rate_limit_info: info })
        }
        // A refusal can be retracted when Claude Code retries or changes models.
        if (message.stop_reason === "refusal") {
          this.stopReason = "refusal"
          return
        }
        const content = Array.isArray(message.content) ? message.content : []
        this.error(
          content
            .map((block: unknown) => jsonObject(block)?.text ?? "")
            .join("") || "Claude Code interactive request failed",
        )
        return
      }
      if (typeof message.id !== "string") return
      if (this.completed.has(message.id)) return
      this.stopReason = message.stop_reason
      if (this.pending && this.pending.message.id !== message.id)
        this.flushWhole(true)
      if (this.fallback && this.fallback.id !== message.id) this.finishWhole()
      if (this.streamed.has(message.id)) return
      const blocks =
        Array.isArray(message.content) ?
          message.content
            .map(jsonObject)
            .filter((block): block is JsonObject => !!block)
        : []
      if (this.pending) {
        this.pending.blocks.push(...blocks)
        this.pending.message = message
        this.pending.updated = Date.now()
      } else this.pending = { message, blocks, updated: Date.now() }
    }
    if (row.type === "system" && row.subtype === "turn_duration" && this.busy)
      this.endingAt = Date.now()
  }

  tick(): void {
    if (this.pending && Date.now() - this.pending.updated >= 150) {
      const unknown = [...this.streams.values()].some(
        (stream) => stream.open && !stream.id,
      )
      if (!unknown || Date.now() - this.pending.updated >= 1000)
        this.flushWhole()
    }
    if (this.endingAt === undefined) return
    if ([...this.streams.values()].some((stream) => stream.open)) {
      if (Date.now() - this.endingAt < 1000) return
      this.error(
        "Claude Code ended its turn before the interactive stream completed",
      )
    }
    this.flushWhole(true)
    this.finishWhole()
    this.settleLimits()
    if (!this.failed)
      this.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: this.stopReason,
      })
    this.endingAt = undefined
    this.busy = false
    this.stopReason = undefined
    // The tap and transcript are tailed independently; duplicates can arrive
    // after result delivery. Keep a bounded recent history across turns.
    for (const id of [...this.streamed, ...this.whole]) this.completed.add(id)
    while (this.completed.size > 1024) {
      const oldest = this.completed.values().next().value
      if (oldest !== undefined) this.completed.delete(oldest)
    }
    this.streams.clear()
    this.streamed.clear()
    this.whole.clear()
  }

  private tellLimits(stream: number, info: JsonObject): void {
    if (stream <= this.limitsTold) return
    this.emit({ type: "rate_limit_event", rate_limit_info: info })
    this.limitsTold = stream
    if (this.pendingLimits && this.pendingLimits.stream <= stream)
      this.pendingLimits = undefined
  }

  private settleLimits(): void {
    for (const [number, stream] of this.streams) {
      if (stream.limits && number >= (this.pendingLimits?.stream ?? 0))
        this.pendingLimits = { stream: number, info: stream.limits }
      stream.limits = undefined
    }
    const limits = this.pendingLimits
    this.pendingLimits = undefined
    if (limits) this.tellLimits(limits.stream, limits.info)
  }

  private flushWhole(finish = false): void {
    const pending = this.pending
    this.pending = undefined
    if (!pending || this.streamed.has(String(pending.message.id))) return
    const id = String(pending.message.id)
    this.whole.add(id)
    if (!this.fallback) {
      this.fallback = { id, message: pending.message, index: 0 }
      this.wire({
        type: "message_start",
        message: { ...pending.message, content: [] },
      })
    }
    this.fallback.message = pending.message
    for (const block of pending.blocks) {
      const index = this.fallback.index++
      const { text, thinking, signature, input, ...start } = block
      this.wire({
        type: "content_block_start",
        index,
        content_block: {
          ...start,
          ...(block.type === "text" ? { text: "" } : {}),
          ...(block.type === "tool_use" ? { input: {} } : {}),
        },
      })
      if (typeof text === "string")
        this.wire({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text },
        })
      if (typeof thinking === "string")
        this.wire({
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking },
        })
      if (typeof signature === "string")
        this.wire({
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature },
        })
      if (input)
        this.wire({
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(input),
          },
        })
      this.wire({ type: "content_block_stop", index })
    }
    if (finish || pending.message.stop_reason === "tool_use") this.finishWhole()
  }

  private finishWhole(): void {
    if (!this.fallback) return
    const message = this.fallback.message
    this.fallback = undefined
    this.wire({
      type: "message_delta",
      delta: {
        stop_reason: message.stop_reason ?? "end_turn",
        stop_sequence: message.stop_sequence ?? null,
      },
      usage: message.usage,
    })
    this.wire({ type: "message_stop" })
  }

  private wire(event: JsonObject): void {
    this.emit({ type: "stream_event", event })
  }
  private error(message: string): void {
    if (this.failed) return
    this.failed = true
    this.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: message,
    })
  }
}
