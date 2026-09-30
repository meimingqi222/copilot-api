import type {
  GeminiGenerateContentResponse,
  GeminiPart,
  GeminiStreamEvent,
} from "~/services/protocols/gemini"
import type { IRPart, IRStop, IRUsage, StreamEvent } from "~/services/ir/types"

import { decodeGeminiPart } from "./part"
import {
  geminiFinishReason,
  geminiUsage,
  geminiUsageMetadata,
  stopFromGemini,
} from "./result"

function openPart(kind: "text" | "thinking"): IRPart {
  return kind === "thinking" ?
      { type: "thinking", text: "", source: { wire: "gemini" } }
    : { type: "text", text: "" }
}

/** Converts Gemini SSE chunks into incremental semantic events. */
export async function* decodeGeminiStream(
  stream: AsyncIterable<{ data?: string }>,
  model: string,
): AsyncIterable<StreamEvent> {
  let started = false
  let index = 0
  let open: { id: string; index: number; type: "text" | "thinking" } | undefined
  let stop: IRStop | undefined
  const close = (): StreamEvent | undefined => {
    if (!open) return undefined
    const event: StreamEvent = {
      type: "part_end",
      partId: open.id,
      index: open.index,
    }
    open = undefined
    return event
  }
  for await (const raw of stream) {
    const data = raw.data
    if (!data || data === "[DONE]") continue
    let chunk: GeminiGenerateContentResponse
    try {
      chunk = JSON.parse(data) as GeminiGenerateContentResponse
    } catch {
      continue
    }
    if (!started) {
      started = true
      yield {
        type: "message_start",
        id: chunk.responseId ?? "gemini-stream",
        model: chunk.modelVersion ?? model,
        source: { wire: "gemini" },
      }
    }
    if (chunk.usageMetadata)
      yield { type: "usage", usage: geminiUsage(chunk.usageMetadata) }
    const candidate = chunk.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      const decoded = decodeGeminiPart(part)
      if (!decoded) continue
      if (decoded.type === "tool_call") {
        const previous = close()
        if (previous) yield previous
        const id = `gemini_tool_${index}`
        const toolIndex = index++
        yield {
          type: "part_start",
          partId: id,
          index: toolIndex,
          part: decoded,
        }
        yield { type: "part_end", partId: id, index: toolIndex }
        continue
      }
      if (decoded.type !== "text" && decoded.type !== "thinking") continue
      const kind = decoded.type
      if (open?.type !== kind) {
        const previous = close()
        if (previous) yield previous
        open = { id: `${kind}_${index}`, index: index++, type: kind }
        yield {
          type: "part_start",
          partId: open.id,
          index: open.index,
          part: openPart(kind),
        }
      }
      if (decoded.text)
        yield {
          type: "part_delta",
          partId: open.id,
          index: open.index,
          delta:
            kind === "thinking" ?
              { type: "thinking", text: decoded.text }
            : { type: "text", text: decoded.text },
        }
      if (decoded.type === "thinking" && part.thoughtSignature)
        yield {
          type: "part_delta",
          partId: open.id,
          index: open.index,
          delta: { type: "signature", text: part.thoughtSignature },
        }
    }
    if (candidate?.finishReason)
      stop = stopFromGemini(candidate.finishReason) ?? stop
  }
  const previous = close()
  if (previous) yield previous
  yield {
    type: "message_end",
    stop: stop ?? { reason: "incomplete" },
    status: stop ? "completed" : "incomplete",
  }
}

/** Gemini client wire encoder: one SSE frame per incremental part. */
export async function* encodeGeminiStream(
  stream: AsyncIterable<StreamEvent>,
  model = "",
): AsyncIterable<GeminiStreamEvent> {
  let id = ""
  let resolvedModel = model
  let usage: IRUsage | undefined
  let ended = false
  const frame = (
    parts: Array<GeminiPart>,
    finishReason?: string,
  ): GeminiStreamEvent => ({
    data: JSON.stringify({
      candidates: [
        {
          index: 0,
          content: { role: "model", parts },
          ...(finishReason && { finishReason }),
        },
      ],
      ...(usage && { usageMetadata: geminiUsageMetadata(usage) }),
      ...(resolvedModel && { modelVersion: resolvedModel }),
      ...(id && { responseId: id }),
    }),
  })
  for await (const event of stream) {
    if (event.type === "message_start") {
      id = event.id
      resolvedModel = event.model || model
      continue
    }
    if (event.type === "part_start") {
      if (event.part.type === "text" && event.part.text)
        yield frame([{ text: event.part.text }])
      else if (event.part.type === "thinking" && event.part.text)
        yield frame([{ text: event.part.text, thought: true }])
      else if (event.part.type === "tool_call") {
        let args: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(event.part.arguments)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            args = parsed as Record<string, unknown>
        } catch {
          /* Truncated tool JSON cannot be represented; send an empty object. */
        }
        yield frame([{ functionCall: { name: event.part.name, args } }])
      }
    } else if (event.type === "part_delta") {
      const delta = event.delta
      if (delta.type === "text") yield frame([{ text: delta.text }])
      else if (delta.type === "thinking")
        yield frame([{ text: delta.text, thought: true }])
      else if (delta.type === "signature")
        yield frame([{ thoughtSignature: delta.text }])
    } else if (event.type === "usage") {
      usage = { ...usage, ...event.usage }
    } else if (event.type === "message_end") {
      ended = true
      yield frame([], geminiFinishReason(event.stop))
    } else if (event.type === "error") {
      ended = true
      yield {
        data: JSON.stringify({
          error: {
            code: event.error.status ?? 500,
            message: event.error.message,
            status: event.error.type,
          },
        }),
      }
    }
  }
  if (!ended) yield frame([], "STOP")
}
