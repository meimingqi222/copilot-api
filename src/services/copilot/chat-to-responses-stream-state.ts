import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"
import type {
  ResponsesPayload,
  ResponsesUsage,
} from "~/services/copilot/responses-api-types"

import { growByteCount } from "~/lib/bounded-text"
import { extractReasoningTextAlias } from "~/lib/thinking"

const MAX_CHAT_TO_RESPONSES_BUFFER_BYTES = 32 * 1024 * 1024

// The `*Bytes` fields track accumulator sizes incrementally. Re-measuring a
// whole accumulated string on every delta flattens its rope, which makes a long
// stream O(n^2) in both time and allocation — see ~/lib/bounded-text.
export interface ChatToResponsesToolCallState {
  arguments: string
  argumentBytes: number
  id: string
  name: string
}

export interface ChatToResponsesStreamState {
  createdAt: number
  createdSent: boolean
  messageOutputAdded: boolean
  model: string
  outputText: string
  outputTextBytes: number
  reasoningText: string
  reasoningTextBytes: number
  request: ResponsesPayload
  responseId: string
  toolCalls: Map<number, ChatToResponsesToolCallState>
  usage?: ResponsesUsage
}

export function createChatToResponsesStreamState(
  request: ResponsesPayload,
): ChatToResponsesStreamState {
  return {
    createdAt: Math.floor(Date.now() / 1000),
    createdSent: false,
    messageOutputAdded: false,
    model: request.model,
    outputText: "",
    outputTextBytes: 0,
    reasoningText: "",
    reasoningTextBytes: 0,
    request,
    responseId: `resp_${Math.random().toString(36).slice(2)}`,
    toolCalls: new Map(),
  }
}

export function getReasoningDelta(
  delta: ChatCompletionChunk["choices"][number]["delta"],
): string {
  // Alias chain aligned with anthropic/stream-translation.ts getThinkingDelta:
  // includes reasoning_content so DeepSeek/Kimi/xAI-style deltas are captured.
  return extractReasoningTextAlias(delta) ?? ""
}

export function appendContentDelta(
  state: ChatToResponsesStreamState,
  content: string | null | undefined,
): void {
  if (!content) return
  state.outputTextBytes = growByteCount(
    state.outputTextBytes,
    content,
    MAX_CHAT_TO_RESPONSES_BUFFER_BYTES,
    "Chat completion output exceeds the maximum size",
  )
  state.outputText += content
}

export function appendReasoningDelta(
  state: ChatToResponsesStreamState,
  delta: ChatCompletionChunk["choices"][number]["delta"],
): void {
  const reasoningDelta = getReasoningDelta(delta)
  if (!reasoningDelta) return
  state.reasoningTextBytes = growByteCount(
    state.reasoningTextBytes,
    reasoningDelta,
    MAX_CHAT_TO_RESPONSES_BUFFER_BYTES,
    "Chat reasoning exceeds the maximum size",
  )
  state.reasoningText += reasoningDelta
}

export function appendToolCallDeltas(
  state: ChatToResponsesStreamState,
  toolCalls: ChatCompletionChunk["choices"][number]["delta"]["tool_calls"],
): void {
  if (!toolCalls) {
    return
  }

  for (const toolCall of toolCalls) {
    const existing = state.toolCalls.get(toolCall.index)
    const argumentsDelta = toolCall.function?.arguments ?? ""
    const argumentBytes = growByteCount(
      existing?.argumentBytes ?? 0,
      argumentsDelta,
      MAX_CHAT_TO_RESPONSES_BUFFER_BYTES,
      "Chat tool arguments exceed the maximum size",
    )
    state.toolCalls.set(toolCall.index, {
      id: toolCall.id ?? existing?.id ?? `call_${toolCall.index}`,
      name: toolCall.function?.name ?? existing?.name ?? "unknown_function",
      arguments: `${existing?.arguments ?? ""}${argumentsDelta}`,
      argumentBytes,
    })
  }
}
