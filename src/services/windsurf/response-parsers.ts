import type { ProtobufNode } from "./protobuf"

import { parseMessage } from "./protobuf"

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChatStreamDelta =
  | { kind: "content"; text: string }
  | { kind: "reasoning_text"; text: string }
  | { kind: "tool_call_init"; callId: string; toolName: string }
  | { kind: "tool_call_args"; args: string; callId?: string }

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
  // UsageMetadata field mapping (verified against field[28] in GetChatMessage-res):
  //   field[2] = input_tokens  (prompt)
  //   field[3] = output_tokens (completion)
  //   field[1] = auxiliary slice (e.g. uncached portion) — not used for totals
  // Cache is authoritative from field[33] and field[28] cached_input_tokens only.
  // Commit 07043c3 misread field[3] as cache; it is output_tokens, which made
  // cache_read_tokens mirror completion_tokens in stats.
  let promptTokens = 0
  let completionTokens = 0
  for (const node of nodes) {
    if (node.field === 2 && node.wire === 0 && node.varint !== undefined) {
      promptTokens = node.varint
    }
    if (node.field === 3 && node.wire === 0 && node.varint !== undefined) {
      completionTokens = node.varint
    }
  }
  if (promptTokens === 0 && completionTokens === 0) return undefined
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cached_tokens: 0,
  }
}

interface Field28TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
}

// field[28] "Token Usage" section contains three named metrics:
//   - "input_tokens"         (float32, real prompt size)
//   - "output_tokens"        (float32, real completion size)
//   - "cached_input_tokens"  (float32, KV cache hits)
// Earlier code only extracted cached_input_tokens and discarded the other
// two, which is why prompt_tokens showed as 0 for models that report usage
// exclusively via field[28] (e.g. Claude Haiku via Windsurf, and GLM-5-2
// when field[7] prompt_tokens is 0).
function findTokenUsageFromField28(
  sections: Array<ProtobufNode>,
): Field28TokenUsage {
  const result: Field28TokenUsage = {}
  for (const section of sections) {
    if (section.field !== 2 || !section.sub) continue

    const nameNode = section.sub.find((n) => n.field === 5)
    if (!nameNode?.raw) continue
    const name = new TextDecoder().decode(nameNode.raw)

    const valueBlock = section.sub.find((n) => n.field === 4)?.sub
    if (!valueBlock) continue
    const valueField = valueBlock.find((n) => n.field === 2 && n.wire === 5)
    if (!valueField?.raw) continue

    const value = parseFloat32(valueField.raw)
    switch (name) {
      case "input_tokens": {
        result.inputTokens = value
        break
      }
      case "output_tokens": {
        result.outputTokens = value
        break
      }
      case "cached_input_tokens": {
        result.cachedInputTokens = value
        break
      }
      default: {
        break
      }
    }
  }
  return result
}

function parseTokenUsageFromField28(
  nodes: Array<ProtobufNode>,
): Field28TokenUsage | undefined {
  for (const node of nodes) {
    if (node.field !== 28 || !node.sub) continue

    const title = node.sub.find((n) => n.field === 1)
    if (!title?.raw) continue
    const titleStr = new TextDecoder().decode(title.raw)
    if (!titleStr.includes("Token Usage")) continue

    return findTokenUsageFromField28(node.sub)
  }
  return undefined
}

// field[28] carries the authoritative full usage (input/output/cached).
// Windsurf semantics: input_tokens EXCLUDES cached_input_tokens (unlike
// OpenAI where prompt_tokens includes cached_tokens). Convert to OpenAI
// semantics here so downstream code (handler.ts prompt-cached subtraction,
// dashboard totalTokens) works correctly:
//   prompt_tokens (OpenAI) = input_tokens + cached_input_tokens
//   total_tokens           = prompt_tokens + completion_tokens (includes cache)
function mergeField28Usage(
  usage: ChatStreamFrame["usage"] | undefined,
  tokenUsage: Field28TokenUsage,
): ChatStreamFrame["usage"] | undefined {
  const inputTokens = Math.round(tokenUsage.inputTokens ?? 0)
  const outputTokens = Math.round(tokenUsage.outputTokens ?? 0)
  const cachedTokens = Math.round(tokenUsage.cachedInputTokens ?? 0)

  // Only apply if we got at least one meaningful value or input_tokens was present
  const hasValue =
    inputTokens > 0
    || outputTokens > 0
    || cachedTokens > 0
    || tokenUsage.inputTokens !== undefined
  if (!hasValue) return usage

  // OpenAI-semantic prompt_tokens = non-cached input + cached input
  const promptTokensOpenAI = inputTokens + cachedTokens

  if (!usage) {
    return {
      prompt_tokens: promptTokensOpenAI,
      completion_tokens: outputTokens,
      total_tokens: promptTokensOpenAI + outputTokens,
      cached_tokens: cachedTokens,
      cache_read_tokens: cachedTokens,
    }
  }

  if (tokenUsage.inputTokens !== undefined) {
    usage.prompt_tokens = promptTokensOpenAI
  }
  if (tokenUsage.outputTokens !== undefined) {
    usage.completion_tokens = outputTokens
  }
  if (tokenUsage.cachedInputTokens !== undefined) {
    usage.cached_tokens = Math.max(usage.cached_tokens, cachedTokens)
    usage.cache_read_tokens = Math.max(
      usage.cache_read_tokens ?? 0,
      cachedTokens,
    )
  }
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
  return usage
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
      if (args) {
        deltas.push({
          kind: "tool_call_args",
          args,
          callId: callId ?? undefined,
        })
      }
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
          const prevCacheRead = usage.cache_read_tokens
          usage = { ...usage, ...metaUsage }
          usage.cached_tokens = prevCached
          usage.cache_read_tokens = prevCacheRead
        } else {
          usage = metaUsage
        }
      }
      continue
    }

    if (node.field === 33 && node.wire === 0 && node.varint !== undefined) {
      // field[33] = KV cache hits (large value, e.g. 50654). This IS the real
      // cache_read_tokens. Must set it on creation, otherwise cross-frame merge
      // in create-chat-completions.ts would only see `cached_tokens` and lose
      // the value when chunk-builders.ts prefers `cache_read_tokens`.
      if (!usage) {
        usage = {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cached_tokens: node.varint,
          cache_read_tokens: node.varint,
        }
      } else {
        usage.cache_read_tokens = (usage.cache_read_tokens ?? 0) + node.varint
        usage.cached_tokens = Math.max(usage.cached_tokens, node.varint)
      }
      continue
    }

    if (node.field === 28 && node.wire === 2 && node.raw) {
      const field28Nodes = parseMessage(node.raw, 0, 6)
      const tokenUsage = parseTokenUsageFromField28([
        { field: 28, wire: 2, sub: field28Nodes },
      ])
      if (tokenUsage) {
        usage = mergeField28Usage(usage, tokenUsage)
      }
    }
  }

  return { deltas, textDone, toolCallsDone, usage }
}

// ── Raw usage signals (cache debug) ───────────────────────────────────────────

export interface WindsurfRawUsageSignals {
  field7?: { f1?: number; f2?: number; f3?: number }
  field33?: number
  field28?: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
  }
}

function readField7Varints(
  sub: Array<ProtobufNode>,
): WindsurfRawUsageSignals["field7"] | undefined {
  const out: NonNullable<WindsurfRawUsageSignals["field7"]> = {}
  for (const node of sub) {
    if (node.wire !== 0 || node.varint === undefined) continue
    if (node.field === 1) out.f1 = node.varint
    if (node.field === 2) out.f2 = node.varint
    if (node.field === 3) out.f3 = node.varint
  }
  if (out.f1 === undefined && out.f2 === undefined && out.f3 === undefined) {
    return undefined
  }
  return out
}

/** Extract unmerged protobuf usage fields for cache diagnostics. */
export function extractRawUsageSignals(
  frame: Uint8Array,
): WindsurfRawUsageSignals | undefined {
  const nodes = parseMessage(frame, 0, 3)
  const signals: WindsurfRawUsageSignals = {}
  let hasSignal = false

  for (const node of nodes) {
    if (node.field === 7 && node.wire === 2 && node.sub) {
      const field7 = readField7Varints(node.sub)
      if (field7) {
        signals.field7 = field7
        hasSignal = true
      }
    }
    if (node.field === 33 && node.wire === 0 && node.varint !== undefined) {
      signals.field33 = node.varint
      hasSignal = true
    }
    if (node.field === 28 && node.wire === 2 && node.raw) {
      const field28Nodes = parseMessage(node.raw, 0, 6)
      const tokenUsage = parseTokenUsageFromField28([
        { field: 28, wire: 2, sub: field28Nodes },
      ])
      if (tokenUsage) {
        signals.field28 = {
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          cachedInputTokens: tokenUsage.cachedInputTokens,
        }
        hasSignal = true
      }
    }
  }

  return hasSignal ? signals : undefined
}

export function mergeRawUsageSignals(
  prev: WindsurfRawUsageSignals | undefined,
  next: WindsurfRawUsageSignals,
): WindsurfRawUsageSignals {
  if (!prev) return { ...next }

  const merged: WindsurfRawUsageSignals = { ...prev }

  if (next.field7) {
    merged.field7 = { ...merged.field7, ...next.field7 }
  }
  if (next.field33 !== undefined) {
    merged.field33 = Math.max(merged.field33 ?? 0, next.field33)
  }
  if (next.field28) {
    merged.field28 = { ...merged.field28, ...next.field28 }
    if (
      next.field28.cachedInputTokens !== undefined
      && merged.field28.cachedInputTokens !== undefined
    ) {
      merged.field28.cachedInputTokens = Math.max(
        merged.field28.cachedInputTokens,
        next.field28.cachedInputTokens,
      )
    }
  }

  return merged
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
