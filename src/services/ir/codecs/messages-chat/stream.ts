import type {
  ChatCompletionChunk,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import type { AnthropicStreamEventData } from "~/services/protocols/anthropic/types"
import type {
  IRPart,
  IRPartDelta,
  IRStop,
  IRUsage,
  StreamEvent,
} from "~/services/ir/types"

import { sanitizeId } from "~/lib/id-sanitizer"
import {
  extractReasoningBlockText,
  extractReasoningTextAlias,
  extractSignatureAlias,
} from "~/lib/thinking"
import {
  anthropicUsageToOpenAI,
  openAIUsageToAnthropic,
} from "~/lib/usage-translation"

type ChatDelta = ChatCompletionChunk["choices"][number]["delta"]

interface CollectedChatDelta {
  content?: string
  reasoningText?: string
  reasoningOpaque?: string
  toolCalls?: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
  finishReason?: ChatCompletionChunk["choices"][number]["finish_reason"]
  usage?: ChatCompletionChunk["usage"]
}

function chunkFromTwin(
  twin: CollectedChatDelta,
  id: string,
  model: string,
): ChatCompletionChunk {
  return {
    id,
    model,
    created: 0,
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          ...(twin.content !== undefined && { content: twin.content }),
          ...(twin.reasoningText !== undefined && {
            reasoning_text: twin.reasoningText,
          }),
          ...(twin.reasoningOpaque !== undefined && {
            reasoning_opaque: twin.reasoningOpaque,
          }),
          ...(twin.toolCalls && { tool_calls: twin.toolCalls }),
        },
        finish_reason: twin.finishReason ?? null,
        logprobs: null,
      },
    ],
    ...(twin.usage && { usage: twin.usage }),
  }
}

function parseChatChunk(data: string): ChatCompletionChunk | undefined {
  let value: unknown
  try {
    value = JSON.parse(data) as unknown
  } catch {
    return undefined
  }
  return (
      value !== null
        && typeof value === "object"
        && "choices" in value
        && Array.isArray(value.choices)
    ) ?
      (value as ChatCompletionChunk)
    : undefined
}

function chatStop(
  reason: ChatCompletionChunk["choices"][number]["finish_reason"],
): IRStop | undefined {
  if (!reason) return undefined
  if (reason === "length") return { reason: "max_tokens", raw: reason }
  if (reason === "tool_calls") return { reason: "tool_calls", raw: reason }
  if (reason === "content_filter") return { reason: "refusal", raw: reason }
  return { reason: "complete", raw: reason }
}

function messagesStop(reason: string | null | undefined): IRStop | undefined {
  if (!reason) return undefined
  if (reason === "max_tokens") return { reason: "max_tokens", raw: reason }
  if (reason === "tool_use") return { reason: "tool_calls", raw: reason }
  if (reason === "stop_sequence")
    return { reason: "stop_sequence", raw: reason }
  if (reason === "pause_turn") return { reason: "pause", raw: reason }
  if (reason === "refusal") return { reason: "refusal", raw: reason }
  return { reason: "complete", raw: reason }
}

function toChatStop(
  stop?: IRStop,
): ChatCompletionChunk["choices"][number]["finish_reason"] {
  if (stop?.reason === "max_tokens") return "length"
  if (stop?.reason === "tool_calls") return "tool_calls"
  if (stop?.reason === "refusal" && stop.raw === "content_filter")
    return "content_filter"
  return "stop"
}

function toMessagesStop(
  stop?: IRStop,
):
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "pause_turn"
  | "refusal" {
  if (stop?.reason === "max_tokens") return "max_tokens"
  if (stop?.reason === "tool_calls") return "tool_use"
  if (stop?.reason === "stop_sequence" && stop.raw === "stop_sequence")
    return "stop_sequence"
  if (stop?.reason === "pause" && stop.raw === "pause_turn") return "pause_turn"
  if (stop?.reason === "refusal" && stop.raw === "refusal") return "refusal"
  return "end_turn"
}

/** Converts OpenAI SSE chunks to incremental semantic events. */
export async function* decodeChatStream(
  stream: AsyncIterable<CopilotStreamEvent>,
): AsyncIterable<StreamEvent> {
  let started = false
  let index = 0
  let open:
    | { id: string; index: number; type: "text" | "thinking" | "tool_call" }
    | undefined
  let stop: IRStop | undefined
  let streamId: string | undefined
  let streamModel: string | undefined
  const tools = new Map<number, { id: string; index: number }>()
  const close = (): StreamEvent | undefined => {
    if (!open) return undefined
    const event: StreamEvent = {
      type: "part_end",
      partId: open.id,
      index: open.index,
    }
    open = undefined
    return event
  }
  for await (const raw of stream) {
    if (raw.data === "[DONE]") break
    if (!raw.data) continue
    const twin = (
      raw as CopilotStreamEvent & { collected?: CollectedChatDelta }
    ).collected
    const chunk =
      twin && streamId !== undefined && streamModel !== undefined ?
        chunkFromTwin(twin, streamId, streamModel)
      : parseChatChunk(raw.data)
    if (!chunk) {
      yield {
        type: "error",
        error: {
          type: "api_error",
          message: "Chat upstream sent an invalid stream frame",
        },
      }
      return
    }
    streamId ??= chunk.id
    streamModel ??= chunk.model
    if (!started) {
      started = true
      yield {
        type: "message_start",
        id: chunk.id,
        model: chunk.model,
        createdAt: chunk.created,
        source: { wire: "chat" },
      }
    }
    if (chunk.usage)
      yield {
        type: "usage",
        usage: {
          source: "reported",
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          cacheWriteTokens:
            chunk.usage.prompt_tokens_details?.cache_creation_input_tokens,
          reasoningTokens:
            chunk.usage.completion_tokens_details?.reasoning_tokens,
        },
      }
    for (const choice of chunk.choices) {
      const delta = choice.delta
      const reasoning =
        extractReasoningTextAlias(delta)
        || delta.reasoning_details?.map(extractReasoningBlockText).find(Boolean)
      if (reasoning) {
        if (open?.type !== "thinking") {
          const previous = close()
          if (previous) yield previous
          open = { id: `thinking_${index}`, index: index++, type: "thinking" }
          yield {
            type: "part_start",
            partId: open.id,
            index: open.index,
            part: { type: "thinking", text: "", source: { wire: "chat" } },
          }
        }
        yield {
          type: "part_delta",
          partId: open.id,
          index: open.index,
          delta: { type: "thinking", text: reasoning },
        }
      }
      const signature =
        extractSignatureAlias(delta)
        || delta.reasoning_details
          ?.map((detail) => detail.signature)
          .find(Boolean)
      if (signature && open?.type === "thinking")
        yield {
          type: "part_delta",
          partId: open.id,
          index: open.index,
          delta: { type: "signature", text: signature },
        }
      if (delta.content) {
        if (open?.type !== "text") {
          const previous = close()
          if (previous) yield previous
          open = { id: `text_${index}`, index: index++, type: "text" }
          yield {
            type: "part_start",
            partId: open.id,
            index: open.index,
            part: { type: "text", text: "" },
          }
        }
        yield {
          type: "part_delta",
          partId: open.id,
          index: open.index,
          delta: { type: "text", text: delta.content },
        }
      }
      for (const call of delta.tool_calls ?? []) {
        if (call.id || call.function?.name) {
          const previous = close()
          if (previous) yield previous
          const id = `tool_${index}`
          const toolIndex = index++
          open = { id, index: toolIndex, type: "tool_call" }
          tools.set(call.index, { id, index: toolIndex })
          yield {
            type: "part_start",
            partId: id,
            index: toolIndex,
            part: {
              type: "tool_call",
              id: sanitizeId(call.id ?? `call_${call.index}`),
              name: call.function?.name ?? "unknown_function",
              arguments: "",
            },
          }
        }
        const tool = tools.get(call.index)
        if (tool && call.function?.arguments)
          yield {
            type: "part_delta",
            partId: tool.id,
            index: tool.index,
            delta: { type: "tool_arguments", text: call.function.arguments },
          }
      }
      stop = chatStop(choice.finish_reason) ?? stop
    }
  }
  const previous = close()
  if (previous) yield previous
  yield {
    type: "message_end",
    stop: stop ?? { reason: "incomplete" },
    status: stop ? "completed" : "incomplete",
  }
}

interface MessagesEventLike {
  type: string
  index?: number
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  content_block?: {
    type?: string
    text?: string
    thinking?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  error?: { type?: string; message?: string; code?: number; status?: number }
}

function messagesUsage(
  usage: NonNullable<MessagesEventLike["usage"]>,
): IRUsage {
  return {
    source: "reported",
    ...(usage.input_tokens !== undefined && {
      inputTokens:
        usage.input_tokens
        + (usage.cache_read_input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0),
    }),
    ...(usage.output_tokens !== undefined && {
      outputTokens: usage.output_tokens,
    }),
    ...(usage.cache_read_input_tokens !== undefined && {
      cacheReadTokens: usage.cache_read_input_tokens,
    }),
    ...(usage.cache_creation_input_tokens !== undefined && {
      cacheWriteTokens: usage.cache_creation_input_tokens,
    }),
  }
}

function messagesContentDelta(
  delta: MessagesEventLike["delta"],
): IRPartDelta | undefined {
  switch (delta?.type) {
    case "text_delta":
      return { type: "text", text: delta.text ?? "" }
    case "thinking_delta":
      return { type: "thinking", text: delta.thinking ?? "" }
    case "signature_delta":
      return { type: "signature", text: delta.signature ?? "" }
    case "input_json_delta":
      return { type: "tool_arguments", text: delta.partial_json ?? "" }
    default:
      return undefined
  }
}

/** Converts Anthropic SSE into incremental semantic events. */
export async function* decodeMessagesStream(
  stream: AsyncIterable<unknown>,
): AsyncIterable<StreamEvent> {
  let started = false
  let ended = false
  let stop: IRStop | undefined
  const blocks = new Map<number, { id: string; index: number; type: string }>()
  for await (const raw of stream) {
    const data = (raw as { data?: string }).data
    if (!data || data === "[DONE]") continue
    let event: MessagesEventLike
    try {
      event = JSON.parse(data) as MessagesEventLike
    } catch {
      continue
    }
    if (event.type === "ping") continue
    if (event.type === "error") {
      yield {
        type: "error",
        error: {
          type: event.error?.type ?? "api_error",
          message: event.error?.message ?? "Anthropic upstream stream error",
          status: event.error?.status ?? event.error?.code,
        },
      }
      return
    }
    if (event.type === "message_start") {
      started = true
      yield {
        type: "message_start",
        id: event.message?.id ?? "",
        model: event.message?.model ?? "",
        source: { wire: "messages" },
      }
      if (event.message?.usage)
        yield { type: "usage", usage: messagesUsage(event.message.usage) }
    } else if (event.type === "content_block_start") {
      const index = event.index ?? blocks.size
      const block = event.content_block
      const id = `messages_${index}`
      blocks.set(index, { id, index, type: block?.type ?? "text" })
      let part: IRPart
      if (block?.type === "thinking")
        part = {
          type: "thinking",
          text: block.thinking ?? "",
          source: { wire: "messages" },
        }
      else if (block?.type === "tool_use")
        part = {
          type: "tool_call",
          id: block.id ?? `call_${index}`,
          name: block.name ?? "unknown_function",
          arguments:
            block.input && Object.keys(block.input).length > 0 ?
              JSON.stringify(block.input)
            : "",
        }
      else part = { type: "text", text: block?.text ?? "" }
      yield { type: "part_start", partId: id, index, part }
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(event.index ?? -1)
      if (!block) continue
      const delta = messagesContentDelta(event.delta)
      if (delta)
        yield {
          type: "part_delta",
          partId: block.id,
          index: block.index,
          delta,
        }
    } else if (event.type === "content_block_stop") {
      const block = blocks.get(event.index ?? -1)
      if (block) {
        yield { type: "part_end", partId: block.id, index: block.index }
        blocks.delete(block.index)
      }
    } else if (event.type === "message_delta") {
      stop = messagesStop(event.delta?.stop_reason) ?? stop
      if (event.usage)
        yield { type: "usage", usage: messagesUsage(event.usage) }
    } else if (event.type === "message_stop") {
      ended = true
      yield { type: "message_end", stop, status: "completed" }
    }
  }
  if (started && !ended)
    yield {
      type: "message_end",
      stop: stop ?? { reason: "incomplete" },
      status: stop ? "completed" : "incomplete",
    }
}

/** Anthropic client wire encoder. No event array or full-response buffering. */
export async function* encodeMessagesStream(
  stream: AsyncIterable<StreamEvent>,
  estimatedInputTokens = 0,
): AsyncIterable<AnthropicStreamEventData> {
  let usage: IRUsage | undefined
  let started = false
  let ended = false
  for await (const event of stream) {
    if (event.type === "message_start") {
      started = true
      yield {
        type: "message_start",
        message: {
          id: event.id,
          type: "message",
          role: "assistant",
          content: [],
          model: event.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
        },
      }
    } else if (event.type === "part_start") {
      const part = event.part
      if (part.type === "thinking") {
        yield {
          type: "content_block_start",
          index: event.index,
          content_block: { type: "thinking", thinking: "" },
        }
        if (part.text)
          yield {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "thinking_delta", thinking: part.text },
          }
      } else if (part.type === "tool_call") {
        yield {
          type: "content_block_start",
          index: event.index,
          content_block: {
            type: "tool_use",
            id: sanitizeId(part.id),
            name: part.name,
            input: {},
          },
        }
        if (part.arguments)
          yield {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "input_json_delta", partial_json: part.arguments },
          }
      } else if (part.type === "text") {
        yield {
          type: "content_block_start",
          index: event.index,
          content_block: { type: "text", text: "" },
        }
        if (part.text)
          yield {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "text_delta", text: part.text },
          }
      } else if (part.type === "server_tool_use") {
        yield {
          type: "content_block_start",
          index: event.index,
          content_block: {
            type: "server_tool_use",
            id: sanitizeId(part.id),
            name: part.name,
            input: {},
          },
        }
        // The tool call is complete when it appears (the proxy already ran
        // it), so the input is emitted as one delta rather than streamed.
        if (part.input)
          yield {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "input_json_delta", partial_json: part.input },
          }
      } else if (part.type === "web_search_result") {
        yield {
          type: "content_block_start",
          index: event.index,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: part.toolUseId,
            content: part.results.map((result) => ({
              type: "web_search_result",
              url: result.url,
              ...(result.title && { title: result.title }),
              ...(result.pageAge && { page_age: result.pageAge }),
              ...(result.encryptedContent && {
                encrypted_content: result.encryptedContent,
              }),
            })),
          },
        }
      }
    } else if (event.type === "part_delta") {
      const delta = event.delta
      if (delta.type === "text")
        yield {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "text_delta", text: delta.text },
        }
      else if (delta.type === "thinking")
        yield {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "thinking_delta", thinking: delta.text },
        }
      else if (delta.type === "signature")
        yield {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "signature_delta", signature: delta.text },
        }
      else
        yield {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "input_json_delta", partial_json: delta.text },
        }
    } else if (event.type === "part_end") {
      yield { type: "content_block_stop", index: event.index }
    } else if (event.type === "usage") {
      usage = { ...usage, ...event.usage }
    } else if (event.type === "message_end") {
      ended = true
      if (event.status === "incomplete") {
        yield {
          type: "error",
          error: {
            type: "api_error",
            message: "Chat upstream stream ended before completion",
          },
        }
        continue
      }
      const converted = openAIUsageToAnthropic({
        prompt_tokens: usage?.inputTokens ?? estimatedInputTokens,
        completion_tokens: usage?.outputTokens ?? 0,
        prompt_tokens_details: {
          cached_tokens: usage?.cacheReadTokens,
          cache_creation_input_tokens: usage?.cacheWriteTokens,
        },
      })
      yield {
        type: "message_delta",
        delta: { stop_reason: toMessagesStop(event.stop), stop_sequence: null },
        usage: {
          input_tokens: converted.input_tokens,
          output_tokens: converted.output_tokens,
          cache_read_input_tokens: converted.cache_read_input_tokens,
          cache_creation_input_tokens: converted.cache_creation_input_tokens,
        },
      }
      yield { type: "message_stop" }
    } else if (event.type === "error") {
      ended = true
      yield {
        type: "error",
        error: {
          type: event.error.type,
          message: event.error.message,
          code: event.error.status,
          status: event.error.status,
        },
      }
    }
  }
  if (started && !ended) {
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage?.outputTokens ?? 0 },
    }
    yield { type: "message_stop" }
  }
}

/** OpenAI client wire encoder. */
export async function* encodeChatStream(
  stream: AsyncIterable<StreamEvent>,
): AsyncIterable<CopilotStreamEvent> {
  let id = ""
  let model = ""
  let created = 0
  let usage: IRUsage | undefined
  let ended = false
  const tools = new Map<string, number>()
  let nextTool = 0
  const chunk = (
    delta: ChatDelta,
    finish: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
  ): ChatCompletionChunk => ({
    id,
    model,
    created,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  })
  for await (const event of stream) {
    if (event.type === "message_start") {
      id = event.id
      model = event.model
      created = event.createdAt ?? Math.floor(Date.now() / 1000)
      yield { data: JSON.stringify(chunk({ role: "assistant", content: "" })) }
    } else if (event.type === "part_start" && event.part.type === "tool_call") {
      const toolIndex = nextTool++
      tools.set(event.partId, toolIndex)
      yield {
        data: JSON.stringify(
          chunk({
            tool_calls: [
              {
                index: toolIndex,
                id: sanitizeId(event.part.id),
                type: "function",
                function: {
                  name: event.part.name,
                  arguments: event.part.arguments,
                },
              },
            ],
          }),
        ),
      }
    } else if (
      event.type === "part_start"
      && event.part.type === "text"
      && event.part.text
    ) {
      yield { data: JSON.stringify(chunk({ content: event.part.text })) }
    } else if (
      event.type === "part_start"
      && event.part.type === "thinking"
      && event.part.text
    ) {
      yield {
        data: JSON.stringify(chunk({ reasoning_content: event.part.text })),
      }
    } else if (event.type === "part_delta") {
      if (event.delta.type === "text")
        yield { data: JSON.stringify(chunk({ content: event.delta.text })) }
      else if (event.delta.type === "thinking")
        yield {
          data: JSON.stringify(chunk({ reasoning_content: event.delta.text })),
        }
      else if (event.delta.type === "signature")
        yield { data: JSON.stringify(chunk({ signature: event.delta.text })) }
      else {
        const toolIndex = tools.get(event.partId)
        if (toolIndex !== undefined)
          yield {
            data: JSON.stringify(
              chunk({
                tool_calls: [
                  {
                    index: toolIndex,
                    function: { arguments: event.delta.text },
                  },
                ],
              }),
            ),
          }
      }
    } else if (event.type === "usage") {
      usage = { ...usage, ...event.usage }
    } else if (event.type === "message_end") {
      if (event.status === "incomplete")
        throw new Error("Anthropic upstream stream ended before completion")
      ended = true
      const translated = anthropicUsageToOpenAI({
        input_tokens: Math.max(
          0,
          (usage?.inputTokens ?? 0)
            - (usage?.cacheReadTokens ?? 0)
            - (usage?.cacheWriteTokens ?? 0),
        ),
        output_tokens: usage?.outputTokens ?? 0,
        cache_read_input_tokens: usage?.cacheReadTokens,
        cache_creation_input_tokens: usage?.cacheWriteTokens,
      })
      yield {
        data: JSON.stringify({
          ...chunk({}, toChatStop(event.stop)),
          ...(usage && {
            usage: {
              prompt_tokens: translated.prompt_tokens,
              completion_tokens: translated.completion_tokens,
              total_tokens:
                translated.prompt_tokens + translated.completion_tokens,
              ...(translated.prompt_tokens_details && {
                prompt_tokens_details: translated.prompt_tokens_details,
              }),
            },
          }),
        }),
      }
    } else if (event.type === "error") {
      throw new Error(`Anthropic upstream stream error: ${event.error.message}`)
    }
  }
  if (!ended) yield { data: JSON.stringify(chunk({}, "stop")) }
  yield { data: "[DONE]" }
}
