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
  ResponsesOutputText,
  ResponsesPayload,
  ResponsesReasoningItem,
  ResponsesResponse,
  ResponsesTool,
  ResponsesToolChoice,
  ResponsesUsage,
} from "~/services/copilot/responses-api-types"

interface StreamingState {
  created: number
  model: string
  responseId: string
  toolCalls: Map<number, ResponsesFunctionCallItem>
}

export function translateResponsesToChatPayload(
  payload: ResponsesPayload,
): ChatCompletionsPayload {
  const messages =
    typeof payload.input === "string" ?
      [{ role: "user", content: payload.input } satisfies Message]
    : translateResponsesInputToMessages(payload.input)

  return {
    model: payload.model,
    messages: [
      ...(payload.instructions ?
        [{ role: "system", content: payload.instructions } satisfies Message]
      : []),
      ...messages,
    ],
    max_tokens: payload.max_output_tokens,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.user,
    ...(payload.text?.format.type === "json_object" ?
      { response_format: { type: "json_object" as const } }
    : {}),
    ...(payload.tools ? { tools: translateResponsesTools(payload.tools) } : {}),
    ...(payload.tool_choice ?
      { tool_choice: translateResponsesToolChoice(payload.tool_choice) }
    : {}),
    ...(payload.reasoning?.effort ?
      { reasoning_effort: payload.reasoning.effort }
    : {}),
  }
}

export function translateResponsesToChatCompletion(
  response: ResponsesResponse,
): ChatCompletionResponse {
  const reasoningTexts = response.output
    ?.filter(
      (item): item is ResponsesReasoningItem => item.type === "reasoning",
    )
    .flatMap((item) => item.summary ?? [])
    .map((part) => part.text)
    .filter(
      (text): text is string => typeof text === "string" && text.length > 0,
    )

  const messageItem = response.output?.find(
    (item): item is ResponsesMessageItem => item.type === "message",
  )
  const toolCalls = response.output
    ?.filter(
      (item): item is ResponsesFunctionCallItem =>
        item.type === "function_call",
    )
    .map((item, index) => translateFunctionCallItem(item, index))

  const contentParts = messageItem?.content
    ?.map((part) => translateOutputTextPart(part))
    .filter((part): part is NonNullable<typeof part> => part !== undefined)

  const reasoningParts = reasoningTexts?.map((text) => ({
    type: "reasoning" as const,
    text,
  }))

  const combinedContent = [...(reasoningParts ?? []), ...(contentParts ?? [])]

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: combinedContent.length > 0 ? combinedContent : null,
          ...(toolCalls && toolCalls.length > 0 ?
            { tool_calls: toolCalls }
          : {}),
          ...(reasoningTexts && reasoningTexts.length > 0 ?
            {
              reasoning_content: reasoningTexts.join(""),
              reasoning_text: reasoningTexts.join(""),
              reasoning_details: reasoningTexts.map((text) => ({ text })),
            }
          : {}),
        },
        logprobs: null,
        finish_reason: determineFinishReason(response),
      },
    ],
    usage: translateUsage(response.usage),
  }
}

export async function* translateResponsesStreamToChatCompletions(
  response: AsyncIterable<CopilotStreamEventLike>,
  model: string,
): AsyncIterable<CopilotStreamEventLike> {
  const state = createStreamingState(model)

  for await (const rawEvent of response) {
    const parsed = parseStreamRecord(rawEvent.data)
    if (!parsed) {
      continue
    }

    const eventType = getString(parsed.type)
    if (!eventType) {
      continue
    }

    if (eventType === "response.failed" || eventType === "error") {
      throw new Error(
        parseErrorMessage(parsed) ?? "Responses API stream failed",
      )
    }

    if (eventType === "response.completed") {
      const completedChunk = buildCompletedResponsesChunk(state, parsed)
      if (completedChunk) {
        yield { data: JSON.stringify(completedChunk) }
      }
      yield { data: "[DONE]" }
      return
    }

    const chunk = translateIncrementalResponsesEvent(state, eventType, parsed)
    if (chunk) {
      yield { data: JSON.stringify(chunk) }
    }
  }

  yield { data: "[DONE]" }
}

function translateResponsesInputToMessages(
  input: Array<ResponsesInputItem>,
): Array<Message> {
  return input.map((item) => {
    if ("role" in item) {
      return {
        role: item.role,
        content: translateResponsesContentToChatContent(item.content),
      }
    }

    if (item.type === "function_call") {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments,
            },
          },
        ],
      }
    }

    return {
      role: "tool",
      tool_call_id: item.call_id,
      content: item.output,
    }
  })
}

function translateResponsesContentToChatContent(
  content: string | Array<ResponsesInputContent>,
): Message["content"] {
  if (typeof content === "string") {
    return content
  }

  const parts = content.flatMap((part) => translateResponsesInputContent(part))
  return parts.length > 0 ? parts : ""
}

function translateResponsesInputContent(
  part: ResponsesInputContent,
): Array<ContentPart> {
  switch (part.type) {
    case "input_text": {
      return [{ type: "text", text: part.text }]
    }
    case "input_image": {
      return [
        {
          type: "image_url",
          image_url: {
            url: part.image_url,
            detail: part.detail,
          },
        },
      ]
    }
    case "input_file": {
      throw new Error("input_file requires upstream /responses support")
    }
    default: {
      return []
    }
  }
}

function translateResponsesTools(tools: Array<ResponsesTool>): Array<Tool> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

function translateResponsesToolChoice(
  toolChoice: ResponsesToolChoice,
): ChatCompletionsPayload["tool_choice"] {
  if (typeof toolChoice === "string") {
    return toolChoice
  }

  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  }
}

function translateIncrementalResponsesEvent(
  state: StreamingState,
  eventType: string,
  parsed: Record<string, unknown>,
): ChatCompletionChunk | undefined {
  switch (eventType) {
    case "response.output_text.delta": {
      return buildOutputTextDeltaChunk(state, parsed)
    }
    case "response.output_item.added": {
      return buildOutputItemAddedChunk(state, parsed)
    }
    case "response.function_call_arguments.delta": {
      return buildFunctionCallArgumentsDeltaChunk(state, parsed)
    }
    case "response.reasoning_summary_text.delta": {
      return buildReasoningSummaryDeltaChunk(state, parsed)
    }
    default: {
      return undefined
    }
  }
}

function buildOutputTextDeltaChunk(
  state: StreamingState,
  parsed: Record<string, unknown>,
): ChatCompletionChunk | undefined {
  const data = getString(parsed.delta)
  if (!data) {
    return undefined
  }

  updateResponseId(state, parsed)
  return createChunk({
    id: state.responseId,
    created: state.created,
    model: state.model,
    delta: { content: data },
  })
}

function buildOutputItemAddedChunk(
  state: StreamingState,
  parsed: Record<string, unknown>,
): ChatCompletionChunk | undefined {
  updateResponseId(state, parsed)
  const outputIndex = getNumber(parsed.output_index)
  const item = parseFunctionCallItem(parsed.item)
  if (outputIndex === undefined || !item) {
    return undefined
  }

  state.toolCalls.set(outputIndex, item)
  return createChunk({
    id: state.responseId,
    created: state.created,
    model: state.model,
    delta: {
      tool_calls: [
        {
          index: outputIndex,
          id: item.call_id,
          type: "function",
          function: {
            name: item.name,
            arguments: item.arguments ?? "",
          },
        },
      ],
    },
  })
}

function buildFunctionCallArgumentsDeltaChunk(
  state: StreamingState,
  parsed: Record<string, unknown>,
): ChatCompletionChunk | undefined {
  const outputIndex = getNumber(parsed.output_index)
  const delta = getString(parsed.delta)
  if (
    outputIndex === undefined
    || !delta
    || !state.toolCalls.get(outputIndex)
  ) {
    return undefined
  }

  return createChunk({
    id: state.responseId,
    created: state.created,
    model: state.model,
    delta: {
      tool_calls: [
        {
          index: outputIndex,
          function: {
            arguments: delta,
          },
        },
      ],
    },
  })
}

function buildReasoningSummaryDeltaChunk(
  state: StreamingState,
  parsed: Record<string, unknown>,
): ChatCompletionChunk | undefined {
  const delta = getString(parsed.delta)
  if (!delta) {
    return undefined
  }

  updateResponseId(state, parsed)
  return createChunk({
    id: state.responseId,
    created: state.created,
    model: state.model,
    delta: {
      reasoning_content: delta,
      reasoning_text: delta,
    },
  })
}

function buildCompletedResponsesChunk(
  state: StreamingState,
  parsed: Record<string, unknown>,
): ChatCompletionChunk | undefined {
  const responseObject = parseResponsesResponse(parsed.response)
  if (!responseObject) {
    return undefined
  }

  state.responseId = responseObject.id
  state.model = responseObject.model || state.model
  const completion = translateResponsesToChatCompletion(responseObject)
  return createChunk({
    id: completion.id,
    created: completion.created,
    model: completion.model,
    delta: {},
    finishReason: completion.choices[0]?.finish_reason ?? "stop",
    usage: completion.usage,
  })
}

function createStreamingState(model: string): StreamingState {
  return {
    created: Math.floor(Date.now() / 1000),
    model,
    responseId: `resp_${Math.random().toString(36).slice(2)}`,
    toolCalls: new Map(),
  }
}

function translateOutputTextPart(
  part: ResponsesOutputText,
): { type: "output_text"; text: string } | undefined {
  const text = part.text
  if (!text) {
    return undefined
  }

  return {
    type: "output_text",
    text,
  }
}

function translateFunctionCallItem(
  item: ResponsesFunctionCallItem,
  index: number,
): ToolCall {
  return {
    id: item.call_id ?? item.id ?? `call_${index}`,
    type: "function",
    function: {
      name: item.name ?? "unknown_function",
      arguments: item.arguments ?? "{}",
    },
  }
}

function determineFinishReason(
  response: ResponsesResponse,
): ChatCompletionResponse["choices"][number]["finish_reason"] {
  if (response.output?.some((item) => item.type === "function_call")) {
    return "tool_calls"
  }

  if (response.incomplete_details?.reason === "max_output_tokens") {
    return "length"
  }

  return "stop"
}

function translateUsage(
  usage: ResponsesUsage | undefined,
): ChatCompletionResponse["usage"] | undefined {
  if (!usage) {
    return undefined
  }

  const promptTokens = usage.input_tokens ?? 0
  const completionTokens = usage.output_tokens ?? 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
    ...((
      usage.input_tokens_details?.cached_tokens !== undefined
      || usage.input_tokens_details?.cache_creation_input_tokens !== undefined
    ) ?
      {
        prompt_tokens_details: {
          ...(usage.input_tokens_details.cached_tokens !== undefined && {
            cached_tokens: usage.input_tokens_details.cached_tokens,
          }),
          ...(usage.input_tokens_details.cache_creation_input_tokens
            !== undefined && {
            cache_creation_input_tokens:
              usage.input_tokens_details.cache_creation_input_tokens,
          }),
        },
      }
    : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined ?
      {
        completion_tokens_details: {
          reasoning_tokens: usage.output_tokens_details.reasoning_tokens,
        },
      }
    : {}),
  }
}

function createChunk(input: {
  id: string
  created: number
  model: string
  delta: ChatCompletionChunk["choices"][number]["delta"]
  finishReason?: ChatCompletionChunk["choices"][number]["finish_reason"]
  usage?: ChatCompletionChunk["usage"]
}): ChatCompletionChunk {
  const { id, created, model, delta, finishReason = null, usage } = input
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

function parseStreamRecord(
  data: string | undefined,
): Record<string, unknown> | undefined {
  if (!data || data === "[DONE]") {
    return undefined
  }

  const parsed = JSON.parse(data) as unknown
  return isRecord(parsed) ? parsed : undefined
}

function updateResponseId(
  state: StreamingState,
  parsed: Record<string, unknown>,
): void {
  const responseId = getString(parsed.response_id)
  if (responseId) {
    state.responseId = responseId
  }
}

function parseFunctionCallItem(
  value: unknown,
): ResponsesFunctionCallItem | undefined {
  if (!isRecord(value) || value.type !== "function_call") {
    return undefined
  }

  return {
    type: "function_call",
    id: getString(value.id),
    call_id: getString(value.call_id),
    name: getString(value.name),
    arguments: getString(value.arguments),
  }
}

function parseResponsesResponse(value: unknown): ResponsesResponse | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const id = getString(value.id)
  const model = getString(value.model)
  if (!id || !model) {
    return undefined
  }

  return {
    id,
    model,
    output:
      Array.isArray(value.output) ?
        (value.output as ResponsesResponse["output"])
      : undefined,
    output_text: getString(value.output_text),
    incomplete_details:
      isRecord(value.incomplete_details) ?
        {
          reason: getString(value.incomplete_details.reason),
        }
      : undefined,
    usage: isRecord(value.usage) ? (value.usage as ResponsesUsage) : undefined,
  }
}

function parseErrorMessage(value: Record<string, unknown>): string | undefined {
  const directMessage = getString(value.message)
  if (directMessage) {
    return directMessage
  }

  if (!isRecord(value.error)) {
    return undefined
  }

  return getString(value.error.message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}
