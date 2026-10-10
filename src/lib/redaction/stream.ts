import { RedactionError, type RedactionScope } from "~/lib/redaction/context"
import { record } from "~/lib/redaction/wire"

type Packet = Record<string, unknown>
interface Frame {
  packet: Packet
  wrapper?: Packet
}
/** Writes a held tail into a minimal protocol frame, creating one unless given a frame to merge into. */
type Emit = (tail: string, frame?: Packet) => Packet

interface Channel {
  /** Chat choice, Messages block, Gemini candidate or Responses delta stream; one group's tails share a frame. */
  group: string
  tail: string
  emit?: Emit
  wrapper?: Packet
  item?: { id: unknown; output: unknown; part: unknown }
  thinking: string
  signature: string
  bytes: number
  wire?: "chat" | "messages" | "gemini"
  field?: string
}

interface DeltaSpec {
  id: string
  group: string
  emit: Emit
  json?: boolean
  thinking?: Channel["wire"]
  /** The channel ends in this frame, so nothing may stay held. */
  final?: boolean
}

const MAX_BLOCK_BYTES = 1024 * 1024
const MAX_RETAINED_BYTES = 4 * 1024 * 1024

function pendingSuffix(text: string): string {
  if (text.endsWith("{") && !text.endsWith("{{")) return "{"
  const start = text.lastIndexOf("{{")
  if (start < 0) return ""
  const suffix = text.slice(start)
  if (
    ["{{SECRET_", "{{HOME_", "{{WORD_"].some((prefix) =>
      prefix.startsWith(suffix),
    )
    || /^\{\{(?:SECRET|HOME|WORD)_[a-f0-9]{0,32}\}?$/.test(suffix)
  )
    return suffix
  return ""
}

function append(change: Packet, key: string, entry: Packet): void {
  change[key] = [...((change[key] as Array<Packet> | undefined) ?? []), entry]
}

class StreamRestorer {
  private readonly channels = new Map<string, Channel>()
  private retained = 0
  private sequence = -1
  /** Wrapper of the frame being processed; tail frames reuse it so SSE event names stay correct. */
  private wrapper?: Packet
  /** Tail frames of channels ending in the current frame; they must precede it. */
  private before: Array<Frame> = []

  private readonly scope: RedactionScope
  private readonly issuer: string

  constructor(scope: RedactionScope, issuer: string) {
    this.scope = scope
    this.issuer = issuer
  }

  process(packet: Packet, wrapper: Packet | undefined): Array<Frame> {
    this.wrapper = wrapper
    this.before = []
    const type = String(packet.type ?? "")
    this.chat(packet)
    this.messages(packet, type)
    this.responses(packet, type)
    this.gemini(packet)
    if (this.channels.size > 1024 || this.retained > MAX_RETAINED_BYTES)
      throw new RedactionError("Redaction stream capacity exceeded", 503)
    return [...this.before, { packet, wrapper }]
  }

  /** Ends matching channels, returning frames that carry their held tails. */
  release(match: (channel: Channel) => boolean = () => true): Array<Frame> {
    const frames = new Map<string, Frame>()
    for (const [id, channel] of this.channels) {
      if (!match(channel)) continue
      if (channel.tail && channel.emit) {
        const merged = frames.get(channel.group)
        frames.set(channel.group, {
          packet: channel.emit(channel.tail, merged?.packet),
          wrapper: merged ? merged.wrapper : channel.wrapper,
        })
      }
      this.seal(channel)
      this.retained -= channel.bytes
      this.channels.delete(id)
    }
    return [...frames.values()]
  }

  output(frame: Frame): unknown {
    if (typeof frame.packet.sequence_number === "number") {
      // A held tail adds an event. Keep downstream sequence numbers monotonic
      // instead of duplicating the earlier delta's number on that extra frame.
      this.sequence = Math.max(this.sequence + 1, frame.packet.sequence_number)
      frame.packet.sequence_number = this.sequence
    }
    const packet = this.scope.restore(frame.packet, this.issuer)
    if (!frame.wrapper) return packet
    // At the client boundary there is no further translation; discard producer-only twins
    // rather than leaving a stale, un-restored duplicate of SSE data.
    const { collected: _collected, ...wrapper } = frame.wrapper
    return { ...wrapper, data: JSON.stringify(packet) }
  }

  private end(match: (channel: Channel) => boolean): void {
    this.before.push(...this.release(match))
  }

  private get(id: string, group: string): Channel {
    let channel = this.channels.get(id)
    if (!channel) {
      channel = { group, tail: "", thinking: "", signature: "", bytes: 0 }
      this.channels.set(id, channel)
    }
    return channel
  }

  private retain(channel: Channel, text: string): void {
    const bytes = Buffer.byteLength(text)
    channel.bytes += bytes
    this.retained += bytes
    if (channel.bytes > MAX_BLOCK_BYTES)
      throw new RedactionError(
        "Signed thinking block exceeds redaction capacity",
        503,
      )
  }

  private sign(channel: Channel, signature: unknown): void {
    if (typeof signature !== "string") return
    channel.signature += signature
    this.retain(channel, signature)
  }

  private seal(channel: Channel): void {
    if (!channel.signature || !channel.thinking) return
    const field = channel.field ?? "thinking"
    const raw =
      channel.wire === "gemini" ?
        { text: channel.thinking, thoughtSignature: channel.signature }
      : channel.wire === "chat" ?
        { [field]: channel.thinking, signature: channel.signature }
      : {
          type: "thinking",
          thinking: channel.thinking,
          signature: channel.signature,
        }
    this.scope.restore(raw, this.issuer)
  }

  private delta(
    object: Packet,
    key: string,
    spec: DeltaSpec,
  ): Channel | undefined {
    const text = object[key]
    if (typeof text !== "string") return
    const channel = this.get(spec.id, spec.group)
    if (spec.thinking) {
      channel.wire = spec.thinking
      channel.field = key
      channel.thinking += text
      this.retain(channel, text)
    }
    const combined = channel.tail + text
    channel.tail = spec.final ? "" : pendingSuffix(combined)
    object[key] = this.scope.restoreText(
      combined.slice(0, combined.length - channel.tail.length),
      spec.json,
    )
    channel.emit = channel.tail ? spec.emit : undefined
    channel.wrapper = channel.tail ? this.wrapper : undefined
    if (!channel.tail && !channel.thinking && !channel.signature)
      this.channels.delete(spec.id)
    return channel
  }

  private chat(packet: Packet): void {
    if (!Array.isArray(packet.choices)) return
    const { choices: _choices, usage: _usage, ...meta } = packet
    for (const raw of packet.choices) {
      const choice = record(raw)
      if (!choice) continue
      const index = choice.index ?? 0
      const group = `chat:${index}`
      const final = Boolean(choice.finish_reason)
      const at =
        (put: (change: Packet, tail: string) => void): Emit =>
        (tail, frame = { ...meta, choices: [{ index, delta: {} }] }) => {
          put((frame.choices as Array<{ delta: Packet }>)[0].delta, tail)
          return frame
        }
      const change = record(choice.delta)
      if (change) this.chatDelta(change, group, final, at)
      if (final) this.end((channel) => channel.group === group)
    }
  }

  private chatDelta(
    change: Packet,
    group: string,
    final: boolean,
    at: (put: (change: Packet, tail: string) => void) => Emit,
  ): void {
    this.delta(change, "content", {
      id: `${group}:text`,
      group,
      final,
      emit: at((out, tail) => (out.content = tail)),
    })
    const details =
      Array.isArray(change.reasoning_details) ?
        change.reasoning_details
      : undefined
    for (const key of ["reasoning_text", "reasoning_content", "reasoning"]) {
      const id = `${group}:thinking:${key}`
      const channel = this.delta(change, key, {
        id,
        group,
        final,
        thinking: "chat",
        emit: at((out, tail) => (out[key] = tail)),
      })
      const existing = channel ?? this.channels.get(id)
      if (!details && existing)
        this.sign(existing, change.signature ?? change.reasoning_opaque)
    }
    for (const [position, rawDetail] of (details ?? []).entries()) {
      const detail = record(rawDetail)
      if (!detail) continue
      const ref =
        detail.index === undefined && detail.id !== undefined ?
          { id: detail.id }
        : { index: detail.index ?? position }
      const id = `${group}:detail:${detail.index ?? detail.id ?? position}`
      for (const key of ["text", "thinking", "reasoning"])
        this.delta(detail, key, {
          id,
          group,
          final,
          thinking: "chat",
          emit: at((out, tail) =>
            append(out, "reasoning_details", {
              ...ref,
              type: detail.type,
              [key]: tail,
            }),
          ),
        })
      this.sign(this.get(id, group), detail.signature)
    }
    for (const rawCall of Array.isArray(change.tool_calls) ?
      change.tool_calls
    : []) {
      const call = record(rawCall)
      const fn = record(call?.function)
      if (!call || !fn) continue
      const ref =
        call.index === undefined && call.id !== undefined ?
          { id: call.id }
        : { index: call.index ?? 0 }
      this.delta(fn, "arguments", {
        id: `${group}:tool:${call.index ?? call.id ?? 0}`,
        group,
        final,
        json: true,
        emit: at((out, tail) =>
          append(out, "tool_calls", { ...ref, function: { arguments: tail } }),
        ),
      })
    }
  }

  private messages(packet: Packet, type: string): void {
    const group = `messages:${packet.index ?? 0}`
    const block = record(packet.content_block)
    if (
      type === "content_block_start"
      && block?.type === "thinking"
      && typeof block.thinking === "string"
    ) {
      const channel = this.get(group, group)
      channel.thinking = block.thinking
      channel.wire = "messages"
      this.retain(channel, block.thinking)
    }
    const change = record(packet.delta)
    if (type === "content_block_delta" && change) {
      const { delta: _delta, ...meta } = packet
      for (const key of ["text", "thinking", "partial_json"])
        this.delta(change, key, {
          id: group,
          group,
          json: key === "partial_json",
          thinking: key === "thinking" ? "messages" : undefined,
          emit: (tail) => ({
            ...meta,
            delta: { type: change.type, [key]: tail },
          }),
        })
      this.sign(this.get(group, group), change.signature)
    }
    if (type === "content_block_stop")
      this.end((channel) => channel.group === group)
    if (type === "message_stop") this.end(() => true)
  }

  private responses(packet: Packet, type: string): void {
    if (!type.startsWith("response.")) return
    if (type.endsWith(".delta") && typeof packet.delta === "string") {
      const part = packet.content_index ?? packet.summary_index ?? 0
      const id = `responses:${packet.item_id ?? packet.output_index ?? 0}:${part}:${type}`
      const channel = this.delta(packet, "delta", {
        id,
        group: id,
        json: type.includes("arguments"),
        emit: (tail) => {
          const { logprobs: _logprobs, ...meta } = packet
          return { ...meta, delta: tail }
        },
      })
      if (channel)
        channel.item = { id: packet.item_id, output: packet.output_index, part }
    }
    if (type.endsWith(".done")) {
      // An item's .done ends only that item (and part); other items may still be mid-placeholder.
      const itemId = packet.item_id ?? record(packet.item)?.id
      const output = packet.output_index
      const part = packet.content_index ?? packet.summary_index
      const scoped = itemId !== undefined || output !== undefined
      this.end(
        ({ item }) =>
          !scoped
          || (item !== undefined
            && ((itemId !== undefined && item.id === itemId)
              || (output !== undefined && item.output === output))
            && (part === undefined || item.part === part)),
      )
    }
    if (
      ["response.completed", "response.failed", "response.incomplete"].includes(
        type,
      )
    )
      this.end(() => true)
  }

  private gemini(packet: Packet): void {
    if (!Array.isArray(packet.candidates)) return
    const { candidates: _candidates, usageMetadata: _usage, ...meta } = packet
    for (const raw of packet.candidates) {
      const candidate = record(raw)
      if (!candidate) continue
      const index = candidate.index ?? 0
      const group = `gemini:${index}`
      const final = Boolean(candidate.finishReason)
      const content = record(candidate.content)
      const role = content?.role ?? "model"
      const parts = Array.isArray(content?.parts) ? content.parts : []
      for (const [position, rawPart] of parts.entries()) {
        const part = record(rawPart)
        if (!part) continue
        const signature = part.thoughtSignature ?? part.thought_signature
        const sealed = Boolean(part.thought) && typeof signature === "string"
        // Signed functionCall parts are complete objects, restored by the normal walker.
        const channel = this.delta(part, "text", {
          id: `${group}:${part.thought ? "thinking" : "text"}:${position}`,
          group,
          final: final || sealed,
          thinking: part.thought ? "gemini" : undefined,
          emit: (
            tail,
            frame = {
              ...meta,
              candidates: [{ index, content: { role, parts: [] } }],
            },
          ) => {
            const candidates = frame.candidates as Array<{
              content: { parts: Array<Packet> }
            }>
            candidates[0].content.parts.push(
              part.thought ? { thought: true, text: tail } : { text: tail },
            )
            return frame
          },
        })
        if (channel && sealed) {
          this.sign(channel, signature)
          this.end((other) => other === channel)
        }
      }
      if (final) this.end((channel) => channel.group === group)
    }
  }
}

/**
 * Restores placeholders as frames pass. Only a channel's possible placeholder prefix is held;
 * it joins that channel's next delta or is sent as its own frame before the channel ends.
 */
export async function* restoreRedactionStream(
  stream: AsyncIterable<unknown>,
  scope: RedactionScope,
  issuer: string,
): AsyncIterable<unknown> {
  const restorer = new StreamRestorer(scope, issuer)
  for await (const raw of stream) {
    const wrapper = record(raw)
    if (!wrapper)
      throw new RedactionError("Unsupported redaction stream frame", 502)
    if (wrapper.data === "[DONE]") {
      for (const frame of restorer.release()) yield restorer.output(frame)
      yield raw
      continue
    }
    let packet: Packet | undefined
    if (typeof wrapper.data === "string") {
      try {
        packet = record(JSON.parse(wrapper.data))
      } catch {
        throw new RedactionError(
          "Malformed upstream JSON frame under redaction",
          502,
        )
      }
    } else if (wrapper.type || wrapper.candidates)
      packet = structuredClone(wrapper)
    else {
      yield raw
      continue
    }
    if (!packet)
      throw new RedactionError("Unsupported redaction stream frame", 502)
    const frames = restorer.process(
      packet,
      typeof wrapper.data === "string" ? wrapper : undefined,
    )
    for (const frame of frames) yield restorer.output(frame)
  }
  for (const frame of restorer.release()) yield restorer.output(frame)
}
