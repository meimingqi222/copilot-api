import { type AnthropicResponse } from "./types"

export function mapOpenAIStopReasonToAnthropic(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  } as const
  return stopReasonMap[finishReason]
}

/**
 * Extracts a thinking signature from an object that may use any of the known
 * alias field names used by various Copilot proxy implementations.
 * Both the streaming delta and non-streaming response message use the same alias chain.
 */
export function extractSignatureAlias(source: {
  reasoning_opaque?: string | null
  thinking_signature?: string | null
  reasoning_signature?: string | null
  signature?: string | null
}): string | undefined {
  return (
    source.reasoning_opaque
    ?? source.thinking_signature
    ?? source.reasoning_signature
    ?? source.signature
    ?? undefined
  )
}
