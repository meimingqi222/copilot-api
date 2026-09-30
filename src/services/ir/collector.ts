import type { IRPart, ResultIR, StreamEvent } from "./types"

/** Fold an upstream stream only for a non-streaming client. */
export async function collectStreamEvents(
  events: AsyncIterable<StreamEvent>,
  signal?: AbortSignal,
): Promise<ResultIR> {
  let result: ResultIR | undefined
  let ended = false
  const openParts = new Map<string, number>()

  for await (const event of events) {
    signal?.throwIfAborted()
    switch (event.type) {
      case "message_start":
        if (result)
          throw new Error("IR stream contains multiple message_start events")
        result = {
          id: event.id,
          model: event.model,
          source: event.source,
          parts: [],
          createdAt: event.createdAt,
        }
        break
      case "part_start":
        if (!result) throw new Error("IR part before message_start")
        if (openParts.has(event.partId)) throw new Error("IR part opened twice")
        result.parts[event.index] = clonePart(event.part)
        openParts.set(event.partId, event.index)
        break
      case "part_delta": {
        if (!result) throw new Error("IR delta before message_start")
        const index = openParts.get(event.partId)
        if (index === undefined || index !== event.index) {
          throw new Error("IR delta references an unopened part")
        }
        const part = result.parts[index]
        if (!part) throw new Error("IR delta references a missing part")
        appendDelta(part, event.delta)
        break
      }
      case "part_end":
        if (openParts.get(event.partId) !== event.index) {
          throw new Error("IR end references an unopened part")
        }
        openParts.delete(event.partId)
        break
      case "usage":
        if (!result) throw new Error("IR usage before message_start")
        result.usage = event.usage
        break
      case "message_end":
        if (!result) throw new Error("IR message_end before message_start")
        result.stop = event.stop
        result.status = event.status ?? "completed"
        ended = true
        break
      case "error":
        if (!result) throw new Error(event.error.message)
        result.error = event.error
        result.stop = { reason: "error", raw: event.error.type }
        result.status = "failed"
        ended = true
        break
    }
  }

  if (!result) throw new Error("IR stream ended before message_start")
  if (!ended) {
    result.stop = { reason: "incomplete" }
    result.status = "incomplete"
  }
  return result
}

function clonePart(part: IRPart): IRPart {
  if (part.type === "tool_result") {
    return { ...part, content: part.content.map((content) => ({ ...content })) }
  }
  return { ...part }
}

function appendDelta(
  part: IRPart,
  delta: Extract<StreamEvent, { type: "part_delta" }>["delta"],
): void {
  switch (delta.type) {
    case "text":
      if (part.type !== "text")
        throw new Error("IR text delta for non-text part")
      part.text += delta.text
      break
    case "thinking":
      if (part.type !== "thinking")
        throw new Error("IR thinking delta for non-thinking part")
      part.text += delta.text
      break
    case "signature":
      if (part.type !== "thinking")
        throw new Error("IR signature delta for non-thinking part")
      part.signature = (part.signature ?? "") + delta.text
      break
    case "tool_arguments":
      if (part.type !== "tool_call")
        throw new Error("IR tool argument delta for non-tool part")
      part.arguments += delta.text
      break
  }
}
