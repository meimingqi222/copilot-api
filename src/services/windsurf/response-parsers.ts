import type { ProtobufNode } from "./protobuf"

import { parseMessage } from "./protobuf"

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChatStreamDelta =
  | { kind: "content"; text: string }
  | { kind: "reasoning_text"; text: string }
  | { kind: "tool_call_init"; callId: string; toolName: string }
  | { kind: "tool_call_args"; args: string }

export interface ChatStreamFrame {
  deltas: Array<ChatStreamDelta>
  /** text generation finished (field 5 = varint 2) */
  textDone: boolean
  /** tool call generation finished (field 5 = varint 10) */
  toolCallsDone: boolean
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    cached_tokens: number
    cache_write_tokens?: number
    cache_read_tokens?: number
  }
}

// ── Frame text decoder ────────────────────────────────────────────────────────

function decodeFrameText(raw: Uint8Array): string | undefined {
  try {
    // @ts-expect-error Bun accepts "utf8" but TypeScript types require "utf-8"
    return new TextDecoder("utf8", { fatal: true }).decode(raw)
  } catch {
    return undefined
  }
}

// ── Float32 helper ────────────────────────────────────────────────────────────

function parseFloat32(raw: Uint8Array): number {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getFloat32(
    0,
    true,
  )
}

// ── Usage metadata parsers ────────────────────────────────────────────────────

function parseUsageFromMeta(
  nodes: Array<ProtobufNode>,
): ChatStreamFrame["usage"] | undefined {
  // UsageMetadata field mapping (verified from live GetChatMessage captures):
  //   field[1] = prompt_tokens
  //   field[2] = completion_tokens
  //   field[3] = cached_tokens (KV cache hits, treated as cache_read_tokens)
  let promptTokens = 0
  let completionTokens = 0
  let cacheReadTokens: number | undefined
  for (const node of nodes) {
    if (node.field === 1 && node.wire === 0 && node.varint !== undefined) {
      promptTokens = node.varint
    }
    if (node.field === 2 && node.wire === 0 && node.varint !== undefined) {
      completionTokens = node.varint
    }
    if (node.field === 3 && node.wire === 0 && node.varint !== undefined) {
      cacheReadTokens = node.varint
    }
  }
  if (promptTokens === 0 && completionTokens === 0) return undefined
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cached_tokens: cacheReadTokens ?? 0,
    cache_read_tokens: cacheReadTokens,
  }
}

function findCachedInputTokens(
  sections: Array<ProtobufNode>,
): number | undefined {
  let foundSection = false
  for (const section of sections) {
    if (section.field !== 2 || !section.sub) continue

    const nameNode = section.sub.find((n) => n.field === 5)
    if (!nameNode?.raw) continue
    const name = new TextDecoder().decode(nameNode.raw)
    if (name !== "cached_input_tokens") continue

    foundSection = true
    const valueBlock = section.sub.find((n) => n.field === 4)?.sub
    if (!valueBlock) continue

    const valueField = valueBlock.find((n) => n.field === 2 && n.wire === 5)
    if (valueField?.raw) return parseFloat32(valueField.raw)
  }
  return foundSection ? 0 : undefined
}

function parseCachedTokensFromField28(
  nodes: Array<ProtobufNode>,
): number | undefined {
  for (const node of nodes) {
    if (node.field !== 28 || !node.sub) continue

    const title = node.sub.find((n) => n.field === 1)
    if (!title?.raw) continue
    const titleStr = new TextDecoder().decode(title.raw)
    if (!titleStr.includes("Token Usage")) continue

    return findCachedInputTokens(node.sub)
  }
  return undefined
}

// ── Tool call delta parsing ───────────────────────────────────────────────────

function parseToolCallDelta(sub: Array<ProtobufNode>): Array<ChatStreamDelta> {
  const deltas: Array<ChatStreamDelta> = []
  const f1 = sub.find((n) => n.field === 1 && n.wire === 2)
  const f2 = sub.find((n) => n.field === 2 && n.wire === 2)
  const f3 = sub.find((n) => n.field === 3 && n.wire === 2)

  if (f1?.raw && f2?.raw) {
    const callId = decodeFrameText(f1.raw)
    const toolName = decodeFrameText(f2.raw)
    if (callId && toolName) {
      deltas.push({ kind: "tool_call_init", callId, toolName })
    }
    if (f3?.raw) {
      const args = decodeFrameText(f3.raw)
      if (args) deltas.push({ kind: "tool_call_args", args })
    }
  } else if (f3?.raw) {
    const args = decodeFrameText(f3.raw)
    if (args) deltas.push({ kind: "tool_call_args", args })
  }

  return deltas
}

// ── Full frame parser ─────────────────────────────────────────────────────────

export function parseChatStreamFrame(frame: Uint8Array): ChatStreamFrame {
  const nodes = parseMessage(frame, 0, 3)
  const deltas: Array<ChatStreamDelta> = []
  let textDone = false
  let toolCallsDone = false
  let usage: ChatStreamFrame["usage"] | undefined

  for (const node of nodes) {
    if (node.field === 3 && node.wire === 2 && node.raw) {
      const text = decodeFrameText(node.raw)
      if (text) deltas.push({ kind: "content", text })
      continue
    }

    if (node.field === 9 && node.wire === 2 && node.raw) {
      const text = decodeFrameText(node.raw)
      if (text) deltas.push({ kind: "reasoning_text", text })
      continue
    }

    if (node.field === 6 && node.wire === 2 && node.raw) {
      const sub = parseMessage(node.raw, 0, 1)
      deltas.push(...parseToolCallDelta(sub))
      continue
    }

    if (node.field === 5 && node.wire === 0) {
      if (node.varint === 2) textDone = true
      else if (node.varint === 10) toolCallsDone = true
      continue
    }

    if (node.field === 7 && node.wire === 2 && node.sub) {
      const metaUsage = parseUsageFromMeta(node.sub)
      if (metaUsage) {
        if (usage) {
          const prevCached = usage.cached_tokens
          usage = { ...usage, ...metaUsage }
          usage.cached_tokens = Math.max(prevCached, metaUsage.cached_tokens)
        } else {
          usage = metaUsage
        }
      }
      continue
    }

    if (node.field === 33 && node.wire === 0 && node.varint !== undefined) {
      if (!usage) {
        usage = {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cached_tokens: node.varint,
        }
      } else {
        usage.cache_read_tokens = (usage.cache_read_tokens ?? 0) + node.varint
        usage.cached_tokens = Math.max(usage.cached_tokens, node.varint)
      }
      continue
    }

    if (node.field === 28 && node.wire === 2 && node.raw) {
      const field28Nodes = parseMessage(node.raw, 0, 6)
      const cached = parseCachedTokensFromField28([
        { field: 28, wire: 2, sub: field28Nodes },
      ])
      if (cached !== undefined) {
        if (!usage) {
          usage = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            cached_tokens: Math.round(cached),
          }
        } else {
          usage.cached_tokens = Math.max(
            usage.cached_tokens,
            Math.round(cached),
          )
        }
      }
    }
  }

  return { deltas, textDone, toolCallsDone, usage }
}

// ── Error frame detection ─────────────────────────────────────────────────────

export function parseWindsurfFrameError(frame: Uint8Array): string | undefined {
  const text = Buffer.from(frame).toString("utf8").trim()
  if (!text.startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string; message?: string }
    }
    if (!parsed.error) return undefined
    return parsed.error.code ?
        `${parsed.error.code}: ${parsed.error.message ?? "unknown error"}`
      : parsed.error.message
  } catch {
    return undefined
  }
}
