import type {
  GeminiGenerateContentResponse,
  GeminiPart,
  GeminiStreamEvent,
} from "~/services/protocols/gemini"
import type { IRPart, IRStop, IRUsage, StreamEvent } from "~/services/ir/types"

import { decodeGeminiPart } from "./part"
import { toBase64Image } from "~/services/ir/codecs/gemini/request"
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
  let hasToolCalls = false
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
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) continue
    const error = (
      chunk as { error?: { code?: number; message?: string; status?: string } }
    ).error
    if (error) {
      yield {
        type: "error",
        error: {
          type: error.status ?? "api_error",
          message: error.message ?? "Gemini upstream stream error",
          status: error.code,
        },
      }
      return
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
      if (decoded.type === "tool_call" || decoded.type === "image") {
        if (decoded.type === "tool_call") hasToolCalls = true
        const previous = close()
        if (previous) yield previous
        const id = `gemini_${decoded.type}_${index}`
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
      stop = stopFromGemini(candidate.finishReason, hasToolCalls)
    else if (chunk.promptFeedback?.blockReason)
      stop = { reason: "refusal", raw: chunk.promptFeedback.blockReason }
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
  const tools = new Map<string, { name: string; arguments: string }>()
  const geminiThinking = new Set<string>()
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
  const incomplete = (): GeminiStreamEvent => ({
    data: JSON.stringify({
      error: {
        code: 502,
        message: "Upstream stream ended before completion",
        status: "api_error",
      },
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
      else if (event.part.type === "thinking") {
        const part = event.part
        if (part.source?.wire === "gemini") geminiThinking.add(event.partId)
        const signature =
          geminiThinking.has(event.partId) && part.signedText === part.text ?
            part.signature
          : undefined
        if (part.text || signature)
          yield frame([
            {
              text: part.text,
              thought: true,
              ...(signature && { thoughtSignature: signature }),
            },
          ])
      } else if (event.part.type === "image") {
        const image = toBase64Image(event.part)
        if (image) yield frame([image])
      } else if (event.part.type === "tool_call") {
        tools.set(event.partId, {
          name: event.part.name,
          arguments: event.part.arguments,
        })
      }
    } else if (event.type === "part_delta") {
      const delta = event.delta
      if (delta.type === "text") yield frame([{ text: delta.text }])
      else if (delta.type === "thinking")
        yield frame([{ text: delta.text, thought: true }])
      else if (delta.type === "signature" && geminiThinking.has(event.partId))
        yield frame([{ text: "", thought: true, thoughtSignature: delta.text }])
      else if (delta.type === "tool_arguments") {
        const tool = tools.get(event.partId)
        if (tool) tool.arguments += delta.text
      }
    } else if (event.type === "part_end") {
      geminiThinking.delete(event.partId)
      const tool = tools.get(event.partId)
      tools.delete(event.partId)
      if (tool) {
        let args: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(tool.arguments)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            args = parsed as Record<string, unknown>
        } catch {
          // Match the result codec's fallback for completed malformed calls.
        }
        yield frame([{ functionCall: { name: tool.name, args } }])
      }
    } else if (event.type === "usage") {
      usage = { ...usage, ...event.usage }
    } else if (event.type === "message_end") {
      yield (
        (event.status === "incomplete" && event.stop?.reason !== "max_tokens")
        || event.stop?.reason === "incomplete"
      ) ?
        incomplete()
      : frame([], geminiFinishReason(event.stop))
      return
    } else if (event.type === "error") {
      yield {
        data: JSON.stringify({
          error: {
            code: event.error.status ?? 500,
            message: event.error.message,
            status: event.error.type,
          },
        }),
      }
      return
    }
  }
  yield incomplete()
}
