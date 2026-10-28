import { asRecord } from "~/lib/json-shape"
import type { CopilotStreamEventLike } from "~/services/protocols/responses/types"

/** Grok emits reasoning content; OpenAI-compatible clients expect summaries. */
export function normalizeXaiReasoningItem(value: unknown): void {
  const item = asRecord(value)
  if (item?.type !== "reasoning" || !Array.isArray(item.content)) return
  if (!Array.isArray(item.summary) || item.summary.length === 0) {
    item.summary = item.content.flatMap((value) => {
      const part = asRecord(value)
      return part?.type === "reasoning_text" && typeof part.text === "string" ?
          [{ type: "summary_text", text: part.text }]
        : []
    })
  }
  delete item.content
}

/** Normalize at the provider boundary for HTTP/WS and stream/collected output. */
export async function* normalizeXaiReasoningStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    if (!event.data || event.data === "[DONE]") {
      yield event
      continue
    }
    let wire: Record<string, unknown> | undefined
    try {
      wire = asRecord(JSON.parse(event.data))
    } catch {
      yield event
      continue
    }
    if (!wire) {
      yield event
      continue
    }
    normalizeXaiReasoningItem(wire.item)
    const response = asRecord(wire.response)
    if (Array.isArray(response?.output)) {
      for (const item of response.output) normalizeXaiReasoningItem(item)
    }

    const type = wire.type
    const reasoningText =
      type === "response.reasoning_text.delta"
      || type === "response.reasoning_text.done"
    const reasoningPart =
      (type === "response.content_part.added"
        || type === "response.content_part.done")
      && asRecord(wire.part)?.type === "reasoning_text"
    if (reasoningText || reasoningPart) {
      if (
        wire.summary_index === undefined
        && wire.content_index !== undefined
      ) {
        wire.summary_index = wire.content_index
      }
      delete wire.content_index
      wire.type =
        reasoningText ?
          type === "response.reasoning_text.delta" ?
            "response.reasoning_summary_text.delta"
          : "response.reasoning_summary_text.done"
        : type === "response.content_part.added" ?
          "response.reasoning_summary_part.added"
        : "response.reasoning_summary_part.done"
      if (reasoningPart)
        wire.part = { ...asRecord(wire.part), type: "summary_text" }
    }
    yield {
      ...event,
      ...(typeof wire.type === "string" ? { event: wire.type } : {}),
      data: JSON.stringify(wire),
    }
    if (type === "response.reasoning_text.done") {
      const { text, ...rest } = wire
      yield {
        ...event,
        event: "response.reasoning_summary_part.done",
        data: JSON.stringify({
          ...rest,
          type: "response.reasoning_summary_part.done",
          part: { type: "summary_text", text },
        }),
      }
    }
  }
}
