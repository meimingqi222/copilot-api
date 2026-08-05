import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  CopilotStreamEventLike,
  ResponsesFunctionCallItem,
  ResponsesInputContent,
  ResponsesInputItem,
  ResponsesMessageItem,
  ResponsesPayload,
  ResponsesReasoningItem,
  ResponsesResponse,
  ResponsesTool,
  ResponsesUsage,
} from "~/services/copilot/responses-api-types"

import {
  buildCompletedRequestFields,
  buildCompletedResponseBase,
  getIncompleteDetails,
  getResponsesReasoning,
} from "~/services/copilot/chat-to-responses-response"
import {
  appendContentDelta,
  appendReasoningDelta,
  appendToolCallDeltas,
  type ChatToResponsesStreamState,
  createChatToResponsesStreamState,
  getReasoningDelta,
} from "~/services/copilot/chat-to-responses-stream-state"

interface BuildResponsesOutputInput {
  outputTextParts: Array<{ type: "output_text"; text: string }>
  reasoningText: string
  responseId: string
  toolCalls: Array<ToolCall>
}

interface BuildCompletedResponsesObjectInput {
  choice: ChatCompletionResponse["choices"][number]
  message: ChatCompletionResponse["choices"][number]["message"]
  outputText: string
  outputTextParts: Array<{ type: "output_text"; text: string }>
  reasoningText: string
  request?: ResponsesPayload
  response: ChatCompletionResponse
}

export function translateToResponsesPayload(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  const instructions = buildInstructions(payload.messages)
  const input = payload.messages.flatMap((message) =>
    translateMessageToResponsesInput(message),
  )

  return {
    model: payload.model,
    ...(instructions ? { instructions } : {}),
    input,
    max_output_tokens: payload.max_tokens,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.user,
    ...(payload.response_format?.type === "json_object" ?
      {
        text: { format: { type: "json_object" as const } },
      }
    : {}),
    ...(payload.tools ? { tools: translateTools(payload.tools) } : {}),
    ...(payload.tool_choice ?
      {
        tool_choice: translateToolChoice(payload.tool_choice),
      }
    : {}),
    ...(payload.reasoning_effort && payload.reasoning_effort !== "none" ?
      {
        reasoning: {
          effort: normalizeReasoningEffort(payload.reasoning_effort),
          summary: "auto" as const,
        },
      }
    : {}),
  }
}

export function translateChatCompletionToResponses(
  response: ChatCompletionResponse,
  request?: ResponsesPayload,
): ResponsesResponse {
  const choice = response.choices[0]
  const message = choice.message
  const outputTextParts = getChatMessageOutputTextParts(message.content)
  const outputText = outputTextParts.map((part) => part.text).join("")
  const reasoningText = getChatMessageReasoningText(message)

  return buildCompletedResponsesObject({
    choice,
    message,
    outputText,
    outputTextParts,
    reasoningText,
    request,
    response,
  })
}

export async function* translateChatCompletionsStreamToResponses(
  response: AsyncIterable<CopilotStreamEventLike>,
  request: ResponsesPayload,
): AsyncIterable<CopilotStreamEventLike> {
  const state = createChatToResponsesStreamState(request)

  for await (const rawEvent of response) {
    if (!rawEvent.data || rawEvent.data === "[DONE]") {
      continue
    }

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    updateChatToResponsesStateFromChunk(state, chunk)

    if (!state.createdSent) {
      state.createdSent = true
      yield {
        data: JSON.stringify({
          type: "response.created",
          response: buildInProgressResponsesResponse(state),
        }),
      }
    }

    for (const event of buildChunkEvents(state, chunk)) {
      yield { data: JSON.stringify(event) }
    }

    const finishReason = chunk.choices[0]?.finish_reason
    if (finishReason) {
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: buildCompletedResponsesResponseFromStream(
            state,
            chunk,
            finishReason,
          ),
        }),
      }
      return
    }
  }

  // Fallback: upstream stream ended without a finish_reason chunk.
  // Emit a synthetic incomplete completion so the client gets a concrete signal
  // instead of an empty stream (which maps to finish_reason=unknown on the client).
  if (state.createdSent) {
    yield {
      data: JSON.stringify({
        type: "response.completed",
        response: buildIncompleteResponseFromStream(state),
      }),
    }
  }
}

function buildCompletedResponsesObject(
  input: BuildCompletedResponsesObjectInput,
): ResponsesResponse {
  const {
    choice,
    message,
    outputText,
    outputTextParts,
    reasoningText,
    request,
    response,
  } = input
  const output = buildResponsesOutputFromChatMessage({
    outputTextParts,
    reasoningText,
    responseId: response.id,
    toolCalls: message.tool_calls ?? [],
  })

  return {
    ...buildCompletedResponseBase({
      choice,
      output,
      outputText,
      response,
      usage: translateChatUsageToResponsesUsage(response.usage),
    }),
    ...buildCompletedRequestFields({
      request,
      reasoningText,
      toolCalls: message.tool_calls,
    }),
  }
}

function updateChatToResponsesStateFromChunk(
  state: ChatToResponsesStreamState,
  chunk: ChatCompletionChunk,
): void {
  state.responseId = chunk.id || state.responseId
  state.model = chunk.model || state.model

  updateResponsesUsage(state, chunk)

  const delta = chunk.choices[0]?.delta
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

function buildInProgressResponsesResponse(
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

function buildCompletedResponsesResponseFromStream(
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

function buildIncompleteResponseFromStream(
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

function buildChunkEvents(
  state: ChatToResponsesStreamState,
  chunk: ChatCompletionChunk,
): Array<Record<string, unknown>> {
  const delta = chunk.choices[0]?.delta
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
    state.messageOutputAdded = true
    events.push({
      type: "response.output_item.added",
      response_id: state.responseId,
      output_index: 0,
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
    output_index: 0,
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
    const outputIndex = toolCall.index + (state.messageOutputAdded ? 1 : 0)
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

function translateToolChoice(
  toolChoice: NonNullable<ChatCompletionsPayload["tool_choice"]>,
): ResponsesPayload["tool_choice"] {
  if (typeof toolChoice === "string") {
    return toolChoice
  }

  return {
    type: "function",
    name: toolChoice.function.name,
  }
}

function normalizeReasoningEffort(
  effort: NonNullable<ChatCompletionsPayload["reasoning_effort"]>,
): "low" | "medium" | "high" {
  switch (effort) {
    case "minimal":
    case "low": {
      return "low"
    }
    case "high":
    case "xhigh":
    case "auto": {
      return "high"
    }
    default: {
      return "medium"
    }
  }
}

function translateTools(tools: Array<Tool>): Array<ResponsesTool> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

function buildInstructions(messages: Array<Message>): string | undefined {
  const instructions = messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) => stringifyMessageContent(message.content))
    .filter((content) => content.length > 0)

  if (instructions.length === 0) {
    return undefined
  }

  return instructions.join("\n\n")
}

function translateMessageToResponsesInput(
  message: Message,
): Array<ResponsesInputItem> {
  if (message.role === "system" || message.role === "developer") {
    return []
  }

  if (message.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: stringifyMessageContent(message.content),
      },
    ]
  }

  if (
    message.role === "assistant"
    && message.tool_calls
    && message.tool_calls.length > 0
  ) {
    const inputItems = buildAssistantInputItems(message)
    if (inputItems.length > 0) {
      return inputItems
    }
  }

  return [
    {
      role: message.role,
      content: translateContent(message.content),
    },
  ]
}

function buildAssistantInputItems(message: Message): Array<ResponsesInputItem> {
  const textContent = stringifyMessageContent(message.content)
  const inputItems: Array<ResponsesInputItem> = []
  if (textContent) {
    inputItems.push({
      role: "assistant",
      content: textContent,
    })
  }

  for (const toolCall of message.tool_calls ?? []) {
    inputItems.push({
      type: "function_call",
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    })
  }

  return inputItems
}

function translateContent(
  content: Message["content"],
): string | Array<ResponsesInputContent> {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  const translated = content.flatMap((part) => translateContentPart(part))
  return translated.length > 0 ? translated : ""
}

function translateContentPart(part: ContentPart): Array<ResponsesInputContent> {
  switch (part.type) {
    case "text": {
      return [{ type: "input_text", text: part.text }]
    }
    case "output_text": {
      return [{ type: "input_text", text: part.text }]
    }
    case "image_url": {
      return [
        {
          type: "input_image",
          image_url: part.image_url.url,
          detail: part.image_url.detail,
        },
      ]
    }
    default: {
      return []
    }
  }
}

function stringifyMessageContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  return content
    .flatMap((part) => {
      switch (part.type) {
        case "text":
        case "output_text": {
          return [part.text]
        }
        case "reasoning": {
          return [part.text ?? part.reasoning ?? ""]
        }
        case "thinking": {
          return [part.text ?? part.thinking ?? ""]
        }
        default: {
          return []
        }
      }
    })
    .filter((part) => part.length > 0)
    .join("\n\n")
}

function getChatMessageOutputTextParts(
  content: Message["content"],
): Array<{ type: "output_text"; text: string }> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "output_text", text: content }] : []
  }

  if (!Array.isArray(content)) {
    return []
  }

  return content.flatMap((part) => {
    switch (part.type) {
      case "text":
      case "output_text": {
        return [{ type: "output_text" as const, text: part.text }]
      }
      default: {
        return []
      }
    }
  })
}

function getChatMessageReasoningText(
  message: ChatCompletionResponse["choices"][number]["message"] | undefined,
): string {
  if (!message) {
    return ""
  }

  if (message.reasoning_text) {
    return message.reasoning_text
  }

  if (typeof message.content === "string" || !Array.isArray(message.content)) {
    return ""
  }

  return message.content
    .flatMap((part) => {
      if (part.type === "reasoning") {
        return [part.text ?? part.reasoning ?? ""]
      }
      if (part.type === "thinking") {
        return [part.text ?? part.thinking ?? ""]
      }
      return []
    })
    .join("")
}

function buildResponsesOutputFromChatMessage(
  input: BuildResponsesOutputInput,
): Array<
  ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesReasoningItem
> {
  const { outputTextParts, reasoningText, responseId, toolCalls } = input
  const output: Array<
    ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesReasoningItem
  > = []

  if (outputTextParts.length > 0) {
    output.push({
      type: "message",
      id: `msg_${responseId}`,
      role: "assistant",
      content: outputTextParts,
    })
  }

  output.push(
    ...toolCalls.map((toolCall) => ({
      type: "function_call" as const,
      id: toolCall.id,
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    })),
  )

  if (reasoningText) {
    output.push({
      type: "reasoning",
      id: `rs_${responseId}`,
      summary: [{ type: "summary_text", text: reasoningText }],
    })
  }

  return output
}

function translateChatUsageToResponsesUsage(
  usage:
    | ChatCompletionResponse["usage"]
    | ChatCompletionChunk["usage"]
    | undefined,
): ResponsesUsage | undefined {
  if (!usage) {
    return undefined
  }

  return {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      ...(usage.prompt_tokens_details?.cache_creation_input_tokens
        !== undefined && {
        cache_creation_input_tokens:
          usage.prompt_tokens_details.cache_creation_input_tokens,
      }),
    },
    output_tokens: usage.completion_tokens,
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    total_tokens: usage.total_tokens,
  }
}
