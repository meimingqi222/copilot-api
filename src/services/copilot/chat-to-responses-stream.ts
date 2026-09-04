import type {
  ChatCompletionChunk,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesFunctionCallItem,
  ResponsesMessageItem,
  ResponsesReasoningItem,
  ResponsesResponse,
} from "~/services/copilot/responses-api-types"

import {
  buildResponsesOutputFromChatMessage,
  translateChatUsageToResponsesUsage,
} from "~/services/copilot/chat-to-responses"
import {
  getIncompleteDetails,
  getResponsesReasoning,
} from "~/services/copilot/chat-to-responses-response"
import {
  appendContentDelta,
  appendReasoningDelta,
  appendToolCallDeltas,
  type ChatToResponsesStreamState,
  getReasoningDelta,
} from "~/services/copilot/chat-to-responses-stream-state"

export function updateChatToResponsesStateFromChunk(
  state: ChatToResponsesStreamState,
  chunk: ChatCompletionChunk,
): void {
  state.responseId = chunk.id || state.responseId
  state.model = chunk.model || state.model

  updateResponsesUsage(state, chunk)

  const delta = chunk.choices?.[0]?.delta

  if (!delta) return
  appendContentDelta(state, delta.content)
  appendReasoningDelta(state, delta)
  appendToolCallDeltas(state, delta.tool_calls)
}

function updateResponsesUsage(
  state: ChatToResponsesStreamState,
  chunk: ChatCompletionChunk,
): void {
  if (chunk.usage) {
    state.usage = translateChatUsageToResponsesUsage(chunk.usage)
  }
}

export function buildInProgressResponsesResponse(
  state: ChatToResponsesStreamState,
): ResponsesResponse {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status: "in_progress",
    error: null,
    model: state.model,
    output: [],
    output_text: state.outputText,
    incomplete_details: null,
    instructions: state.request.instructions ?? null,
    max_output_tokens: state.request.max_output_tokens ?? null,
    parallel_tool_calls: state.request.parallel_tool_calls ?? null,
    previous_response_id: state.request.previous_response_id ?? null,
    reasoning: {
      effort: state.request.reasoning?.effort ?? null,
      summary: null,
    },
    store: state.request.store ?? null,
    temperature: state.request.temperature ?? null,
    text: state.request.text ?? { format: { type: "text" } },
    tool_choice: state.request.tool_choice ?? "auto",
    tools: state.request.tools ?? [],
    top_p: state.request.top_p ?? null,
    truncation: state.request.truncation ?? null,
    usage: state.usage,
    user: state.request.user ?? null,
    metadata: state.request.metadata ?? {},
  }
}

export function buildCompletedResponsesResponseFromStream(
  state: ChatToResponsesStreamState,
  chunk: ChatCompletionChunk,
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"],
): ResponsesResponse {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    completed_at: chunk.created,
    status: "completed",
    error: null,
    model: state.model,
    output: buildCompletedOutput(state),
    output_text: state.outputText,
    incomplete_details: getIncompleteDetails(finishReason),
    instructions: state.request.instructions ?? null,
    max_output_tokens: state.request.max_output_tokens ?? null,
    parallel_tool_calls:
      state.request.parallel_tool_calls ?? state.toolCalls.size > 1,
    previous_response_id: state.request.previous_response_id ?? null,
    reasoning: getResponsesReasoning(state.request, state.reasoningText),
    store: state.request.store ?? null,
    temperature: state.request.temperature ?? null,
    text: state.request.text ?? { format: { type: "text" } },
    tool_choice: state.request.tool_choice ?? "auto",
    tools: state.request.tools ?? [],
    top_p: state.request.top_p ?? null,
    truncation: state.request.truncation ?? null,
    usage: state.usage ?? translateChatUsageToResponsesUsage(chunk.usage),
    user: state.request.user ?? null,
    metadata: state.request.metadata ?? {},
  }
}

export function buildIncompleteResponseFromStream(
  state: ChatToResponsesStreamState,
): ResponsesResponse {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    completed_at: Math.floor(Date.now() / 1000),
    status: "incomplete",
    error: null,
    model: state.model,
    output: buildCompletedOutput(state),
    output_text: state.outputText,
    incomplete_details: { reason: "interrupted" },
    instructions: state.request.instructions ?? null,
    max_output_tokens: state.request.max_output_tokens ?? null,
    parallel_tool_calls:
      state.request.parallel_tool_calls ?? state.toolCalls.size > 1,
    previous_response_id: state.request.previous_response_id ?? null,
    reasoning: getResponsesReasoning(state.request, state.reasoningText),
    store: state.request.store ?? null,
    temperature: state.request.temperature ?? null,
    text: state.request.text ?? { format: { type: "text" } },
    tool_choice: state.request.tool_choice ?? "auto",
    tools: state.request.tools ?? [],
    top_p: state.request.top_p ?? null,
    truncation: state.request.truncation ?? null,
    usage: state.usage,
    user: state.request.user ?? null,
    metadata: state.request.metadata ?? {},
  }
}

function buildCompletedOutput(
  state: ChatToResponsesStreamState,
): Array<
  ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesReasoningItem
> {
  return buildResponsesOutputFromChatMessage({
    outputTextParts:
      state.outputText.length > 0 ?
        [{ type: "output_text", text: state.outputText }]
      : [],
    reasoningText: state.reasoningText,
    responseId: state.responseId,
    toolCalls: buildToolCallsFromStreamState(state),
  })
}

function buildToolCallsFromStreamState(
  state: ChatToResponsesStreamState,
): Array<ToolCall> {
  return [...state.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, toolCall]) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }))
}

export function buildChunkEvents(
  state: ChatToResponsesStreamState,
  chunk: ChatCompletionChunk,
): Array<Record<string, unknown>> {
  const delta = chunk.choices?.[0]?.delta

  if (!delta) return []
  return [
    ...buildReasoningEvents(state, delta),
    ...buildContentEvents(state, delta.content),
    ...buildToolCallEvents(state, delta.tool_calls),
  ]
}

function buildReasoningEvents(
  state: ChatToResponsesStreamState,
  delta: ChatCompletionChunk["choices"][number]["delta"],
): Array<Record<string, unknown>> {
  const reasoningDelta = getReasoningDelta(delta)
  if (!reasoningDelta) {
    return []
  }

  return [
    {
      type: "response.reasoning_summary_text.delta",
      response_id: state.responseId,
      delta: reasoningDelta,
    },
  ]
}

function buildContentEvents(
  state: ChatToResponsesStreamState,
  content: string | null | undefined,
): Array<Record<string, unknown>> {
  if (!content) {
    return []
  }

  const events: Array<Record<string, unknown>> = []
  if (!state.messageOutputAdded) {
    const messageIndex = Math.max(state.toolCalls.size, 0)
    state.messageOutputAdded = true
    state.messageOutputIndex = messageIndex
    events.push({
      type: "response.output_item.added",
      response_id: state.responseId,
      output_index: messageIndex,
      item: {
        type: "message",
        id: `msg_${state.responseId}`,
        role: "assistant",
        content: [],
      },
    })
  }

  events.push({
    type: "response.output_text.delta",
    response_id: state.responseId,
    output_index: state.messageOutputIndex ?? 0,
    delta: content,
  })
  return events
}

function buildToolCallEvents(
  state: ChatToResponsesStreamState,
  toolCalls: ChatCompletionChunk["choices"][number]["delta"]["tool_calls"],
): Array<Record<string, unknown>> {
  if (!toolCalls) {
    return []
  }

  const events: Array<Record<string, unknown>> = []
  for (const toolCall of toolCalls) {
    const messageOffset =
      state.messageOutputAdded || state.messageOutputIndex !== undefined ? 1 : 0
    const outputIndex = toolCall.index + messageOffset
    if (toolCall.id && toolCall.function?.name) {
      events.push(createToolCallStartedEvent(state, outputIndex, toolCall))
    }

    if (toolCall.function?.arguments) {
      events.push(createToolCallDeltaEvent(state, outputIndex, toolCall))
    }
  }

  return events
}

function createToolCallStartedEvent(
  state: ChatToResponsesStreamState,
  outputIndex: number,
  toolCall: NonNullable<
    ChatCompletionChunk["choices"][number]["delta"]["tool_calls"]
  >[number],
): Record<string, unknown> {
  return {
    type: "response.output_item.added",
    response_id: state.responseId,
    output_index: outputIndex,
    item: {
      type: "function_call",
      id: toolCall.id,
      call_id: toolCall.id,
      name: toolCall.function?.name,
      arguments: "",
    },
  }
}

function createToolCallDeltaEvent(
  state: ChatToResponsesStreamState,
  outputIndex: number,
  toolCall: NonNullable<
    ChatCompletionChunk["choices"][number]["delta"]["tool_calls"]
  >[number],
): Record<string, unknown> {
  return {
    type: "response.function_call_arguments.delta",
    response_id: state.responseId,
    item_id:
      toolCall.id
      ?? state.toolCalls.get(toolCall.index)?.id
      ?? `call_${toolCall.index}`,
    output_index: outputIndex,
    delta: toolCall.function?.arguments,
  }
}
