import { asRecord } from "~/lib/json-shape"

const TERMINALS = new Set([
  "error",
  "message_stop",
  "response.completed",
  "response.incomplete",
  "response.failed",
])
const FAILURES = new Set(["error", "response.failed"])

export interface DiagnosticText {
  channel: string
  kind: "text" | "reasoning" | "tool"
  text: string
}

/** Only incremental payloads count: final snapshots must not inflate metrics. */
export function inspectDiagnosticEvent(value: unknown): {
  texts: DiagnosticText[]
  terminal: boolean
  failed: boolean
  incomplete: boolean
} {
  const wire = asRecord(value)
  const texts: DiagnosticText[] = []
  let terminal = false
  let failed = false
  if (!wire) return { texts, terminal, failed, incomplete: false }
  const add = (
    channel: string,
    kind: DiagnosticText["kind"],
    text: unknown,
  ) => {
    if (typeof text === "string" && text) texts.push({ channel, kind, text })
  }
  const type = wire.type
  if (Array.isArray(wire.choices)) {
    for (const [index, value] of wire.choices.entries()) {
      const choice = asRecord(value)
      const delta = asRecord(choice?.delta)
      const prefix = `choice:${choice?.index ?? index}`
      add(prefix, "text", delta?.content)
      add(
        prefix,
        "reasoning",
        delta?.reasoning_content ?? delta?.reasoning_text ?? delta?.reasoning,
      )
      if (Array.isArray(delta?.tool_calls)) {
        for (const [i, call] of delta.tool_calls.entries()) {
          const tool = asRecord(call)
          add(
            `${prefix}:tool:${tool?.index ?? i}`,
            "tool",
            asRecord(tool?.function)?.arguments,
          )
        }
      }
      terminal ||= choice?.finish_reason != null
    }
  }
  if (type === "content_block_start") {
    const block = asRecord(wire.content_block)
    const channel = `block:${wire.index ?? 0}`
    if (block?.type === "text") add(channel, "text", block.text)
    if (block?.type === "thinking") add(channel, "reasoning", block.thinking)
  }
  if (type === "content_block_delta") {
    const delta = asRecord(wire.delta)
    const channel = `block:${wire.index ?? 0}`
    if (delta?.type === "text_delta") add(channel, "text", delta.text)
    if (delta?.type === "thinking_delta")
      add(channel, "reasoning", delta.thinking)
    if (delta?.type === "input_json_delta")
      add(channel, "tool", delta.partial_json)
  }
  const channel = `output:${wire.output_index ?? 0}`
  if (
    type === "response.output_text.delta"
    || type === "response.refusal.delta"
  )
    add(channel, "text", wire.delta)
  if (
    type === "response.reasoning_text.delta"
    || type === "response.reasoning_summary_text.delta"
  )
    add(channel, "reasoning", wire.delta)
  if (type === "response.function_call_arguments.delta")
    add(channel, "tool", wire.delta)
  terminal ||= inspectGeminiEvent(wire, add)
  terminal ||= typeof type === "string" && TERMINALS.has(type)
  failed =
    (typeof type === "string" && FAILURES.has(type)) || wire.error != null
  return { texts, terminal, failed, incomplete: isIncompleteEvent(wire) }
}

function isIncompleteEvent(wire: Record<string, unknown>): boolean {
  return (
    wire.type === "response.incomplete"
    || asRecord(wire.delta)?.stop_reason === "max_tokens"
    || (Array.isArray(wire.choices)
      && wire.choices.some(
        (choice) => asRecord(choice)?.finish_reason === "length",
      ))
    || (Array.isArray(wire.candidates)
      && wire.candidates.some(
        (candidate) => asRecord(candidate)?.finishReason === "MAX_TOKENS",
      ))
  )
}

function inspectGeminiEvent(
  wire: Record<string, unknown>,
  add: (channel: string, kind: DiagnosticText["kind"], text: unknown) => void,
): boolean {
  let terminal = false
  if (Array.isArray(wire.candidates)) {
    for (const [index, value] of wire.candidates.entries()) {
      const candidate = asRecord(value)
      const content = asRecord(candidate?.content)
      if (Array.isArray(content?.parts)) {
        for (const part of content.parts) {
          const block = asRecord(part)
          add(
            `candidate:${candidate?.index ?? index}`,
            block?.thought === true ? "reasoning" : "text",
            block?.text,
          )
        }
      }
      terminal ||= typeof candidate?.finishReason === "string"
    }
  }
  return terminal
}
