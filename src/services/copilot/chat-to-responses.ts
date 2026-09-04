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

import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import {
  extractReasoningBlockText,
  extractReasoningPartsText,
  extractReasoningTextAlias,
} from "~/lib/thinking"
import {
  buildCompletedRequestFields,
  buildCompletedResponseBase,
} from "~/services/copilot/chat-to-responses-response"
import {
  buildChunkEvents,
  buildCompletedResponsesResponseFromStream,
  buildIncompleteResponseFromStream,
  buildInProgressResponsesResponse,
  updateChatToResponsesStateFromChunk,
} from "~/services/copilot/chat-to-responses-stream"
import { createChatToResponsesStreamState } from "~/services/copilot/chat-to-responses-stream-state"

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
  // Matches `protocols/anthropic/non-stream-translation.ts`: an upstream that
  // returns no choices (content filter, some gateways) would otherwise surface
  // as `Cannot read properties of undefined (reading 'message')` here.

  const choice = response.choices?.[0]

  if (!choice) {
    throw new Error(
      `Unexpected empty choices in OpenAI response (id: ${response.id})`,
    )
  }
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
  memoryTraceId?: string,
): AsyncIterable<CopilotStreamEventLike> {
  const state = createChatToResponsesStreamState(request)
  let chunkCount = 0
  let nextCheckpointBytes = 1024 * 1024
  updateMemoryTrace(memoryTraceId, "chat_to_responses_stream_start")

  for await (const rawEvent of response) {
    if (!rawEvent.data || rawEvent.data === "[DONE]") {
      continue
    }

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    updateChatToResponsesStateFromChunk(state, chunk)
    chunkCount += 1
    const accumulatedBytes = state.outputTextBytes + state.reasoningTextBytes
    if (chunkCount % 256 === 0 || accumulatedBytes >= nextCheckpointBytes) {
      updateMemoryTrace(memoryTraceId, "chat_to_responses_accumulating", {
        chunkCount,
        outputBytes: state.outputTextBytes,
        reasoningBytes: state.reasoningTextBytes,
        toolCalls: state.toolCalls.size,
      })
      nextCheckpointBytes = accumulatedBytes + 1024 * 1024
    }

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

    const finishReason = chunk.choices?.[0]?.finish_reason
    if (finishReason) {
      updateMemoryTrace(memoryTraceId, "response_completed_stringify_start", {
        chunkCount,
        outputBytes: state.outputTextBytes,
        reasoningBytes: state.reasoningTextBytes,
        toolCalls: state.toolCalls.size,
      })
      const completedEvent = JSON.stringify({
        type: "response.completed",
        response: buildCompletedResponsesResponseFromStream(
          state,
          chunk,
          finishReason,
        ),
      })
      updateMemoryTrace(memoryTraceId, "response_completed_serialized", {
        chunkCount,
        completedEventBytes: Buffer.byteLength(completedEvent),
      })
      yield {
        data: completedEvent,
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

  if (message.role === "assistant") {
    const reasoningText =
      extractReasoningTextAlias(
        message as unknown as Record<string, string | null>,
      )
      ?? messageTopLevelReasoningDetailsText(
        message as unknown as Record<string, unknown>,
      )
      ?? extractReasoningPartsText(message.content)
    const hasToolCalls =
      message.tool_calls !== undefined && message.tool_calls.length > 0
    const hasReasoningInContent =
      Array.isArray(message.content)
      && message.content.some(
        (p) => p.type === "reasoning" || p.type === "thinking",
      )
    if (hasToolCalls) {
      const inputItems = buildAssistantInputItems(
        message,
        Boolean(reasoningText && hasReasoningInContent),
      )
      if (inputItems.length > 0) {
        return injectAssistantReasoning(inputItems, reasoningText)
      }
    }
    if (reasoningText) {
      const content =
        hasReasoningInContent ?
          translateContentWithoutReasoning(message.content)
        : translateContent(message.content)
      const prefix: Array<ResponsesInputContent> = [
        { type: "input_text", text: `[historical reasoning] ${reasoningText}` },
      ]
      if (typeof content === "string") {
        return [
          {
            role: message.role,
            content:
              content ?
                [...prefix, { type: "input_text" as const, text: content }]
              : prefix,
          },
        ]
      }
      return [
        {
          role: message.role,
          content: [...prefix, ...content],
        },
      ]
    }
    const translated = translateContent(message.content)
    if (
      translated === ""
      || (Array.isArray(translated) && translated.length === 0)
    ) {
      return []
    }
    return [
      {
        role: message.role,
        content: translated,
      },
    ]
  }

  const translated = translateContent(message.content)

  const isEmpty =
    translated === "" || (Array.isArray(translated) && translated.length === 0)
  if (isEmpty) {
    if (message.role === "user") {
      return [{ role: message.role, content: "" }]
    }
    return []
  }
  return [
    {
      role: message.role,
      content: translated,
    },
  ]
}

function messageTopLevelReasoningDetailsText(
  message: Record<string, unknown>,
): string | undefined {
  const details = message["reasoning_details"] as
    | Array<{ text?: string; reasoning?: string; thinking?: string }>
    | undefined
  if (!Array.isArray(details) || details.length === 0) return undefined
  const text = details.map((d) => extractReasoningBlockText(d) ?? "").join("")
  return text || undefined
}

function injectAssistantReasoning(
  items: Array<ResponsesInputItem>,
  reasoningText: string | undefined,
): Array<ResponsesInputItem> {
  if (!reasoningText) return items
  const first = items[0]

  if (first && "role" in first && first.role === "assistant") {
    const isStringContent = typeof first.content === "string"
    const existing: Array<ResponsesInputContent> =
      isStringContent ?
        [{ type: "input_text" as const, text: first.content as string }]
      : [...(first.content as Array<ResponsesInputContent>)]
    return [
      {
        role: "assistant" as const,
        content: [
          {
            type: "input_text" as const,
            text: `[historical reasoning] ${reasoningText}`,
          },
          ...existing,
        ],
      },
      ...items.slice(1),
    ]
  }
  return [
    {
      role: "assistant" as const,
      content: [
        { type: "input_text", text: `[historical reasoning] ${reasoningText}` },
      ],
    },
    ...items,
  ]
}

function buildAssistantInputItems(
  message: Message,
  excludeReasoning = false,
): Array<ResponsesInputItem> {
  const textContent =
    excludeReasoning ?
      stringifyMessageContentWithoutReasoning(message.content)
    : stringifyMessageContent(message.content)
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

function stringifyMessageContentWithoutReasoning(
  content: Message["content"],
): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) => {
      switch (part.type) {
        case "text":
        case "output_text": {
          return [part.text]
        }
        default: {
          return []
        }
      }
    })
    .filter((part) => part.length > 0)
    .join("\n\n")
}

function translateContentWithoutReasoning(
  content: Message["content"],
): string | Array<ResponsesInputContent> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const translated = content
    .filter((part) => part.type !== "reasoning" && part.type !== "thinking")
    .flatMap((part) => translateContentPart(part))
  return translated.length > 0 ? translated : ""
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
    case "reasoning":
    case "thinking": {
      const text = extractReasoningBlockText(part) ?? ""
      if (!text) return []
      return [{ type: "input_text", text: `[reasoning:${part.type}] ${text}` }]
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
        case "reasoning":
        case "thinking": {
          return [extractReasoningBlockText(part) ?? ""]
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

  // `reasoning_content` is what DeepSeek/Kimi/Qwen/GLM upstreams actually
  // emit; the streaming path accepts all four spellings (`getReasoningDelta`),
  // so the non-streaming path must too. This path does not run through
  // `routes/chat-completions/normalize.ts`, so there is no alias fallback
  // behind it.
  // An empty top-level alias counts as absent (see `extractReasoningTextAlias`)
  // and falls through to `reasoning_details` (the OpenRouter convention, and
  // the only place such upstreams put it) and then to reasoning carried as
  // content parts. `getReasoningDelta` walks the same order.
  const topLevel = extractReasoningTextAlias(message)
  if (topLevel) return topLevel

  let detailsText = ""
  for (const detail of message.reasoning_details ?? []) {
    detailsText += extractReasoningBlockText(detail) ?? ""
  }
  return detailsText || extractReasoningPartsText(message.content)
}

export function buildResponsesOutputFromChatMessage(
  input: BuildResponsesOutputInput,
): Array<
  ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesReasoningItem
> {
  const { outputTextParts, reasoningText, responseId, toolCalls } = input
  const output: Array<
    ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesReasoningItem
  > = []

  // Reasoning precedes the output it explains — Responses clients replay
  // `output` items in order, and OpenAI rejects a reasoning item that follows
  // the message/function_call it belongs to. No `encrypted_content` is
  // available: a Chat Completions upstream never produces one.
  if (reasoningText) {
    output.push({
      type: "reasoning",
      id: `rs_${responseId}`,
      summary: [{ type: "summary_text", text: reasoningText }],
    })
  }

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

  return output
}

export function translateChatUsageToResponsesUsage(
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
