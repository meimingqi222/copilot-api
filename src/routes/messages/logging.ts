import { asRecord } from "~/lib/json-shape"
import { isNonEmptyString } from "~/lib/json-shape"

export function isMessagesOutputEvent(event: {
  content_block?: unknown
  delta?: unknown
  type?: string
}): boolean {
  if (event.type === "content_block_start") {
    const block = asRecord(event.content_block)
    if (!block) return false
    if (block.type === "tool_use" || block.type === "server_tool_use") {
      return isNonEmptyString(block.name) || hasMeaningfulObject(block.input)
    }
    return (
      isNonEmptyString(block.text)
      || isNonEmptyString(block.thinking)
      || isNonEmptyString(block.data)
    )
  }

  if (event.type === "content_block_delta") {
    const delta = asRecord(event.delta)
    if (!delta || delta.type === "signature_delta") return false
    return (
      isNonEmptyString(delta.text)
      || isNonEmptyString(delta.thinking)
      || isNonEmptyString(delta.partial_json)
      || isNonEmptyString(delta.data)
    )
  }

  return false
}

function hasMeaningfulObject(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && Object.keys(value).length > 0,
  )
}
