export function isMessagesOutputEvent(event: {
  content_block?: unknown
  delta?: unknown
  type?: string
}): boolean {
  if (event.type === "content_block_start") {
    const block = asRecord(event.content_block)
    if (!block) return false
    if (block.type === "tool_use" || block.type === "server_tool_use") {
      return hasNonEmptyString(block.name) || hasMeaningfulObject(block.input)
    }
    return (
      hasNonEmptyString(block.text)
      || hasNonEmptyString(block.thinking)
      || hasNonEmptyString(block.data)
    )
  }

  if (event.type === "content_block_delta") {
    const delta = asRecord(event.delta)
    if (!delta || delta.type === "signature_delta") return false
    return (
      hasNonEmptyString(delta.text)
      || hasNonEmptyString(delta.thinking)
      || hasNonEmptyString(delta.partial_json)
      || hasNonEmptyString(delta.data)
    )
  }

  return false
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function hasMeaningfulObject(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && Object.keys(value).length > 0,
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ?
      (value as Record<string, unknown>)
    : undefined
}
