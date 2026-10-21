import { cacheCreationFor1h } from "~/lib/cache-usage"
import { sanitizeId } from "~/lib/id-sanitizer"
import {
  extractReasoningBlockText,
  extractReasoningTextAlias,
  extractSignatureAlias,
} from "~/lib/thinking"
import { anthropicUsageToOpenAI } from "~/lib/usage-translation"
import {
  imageFromChat,
  imageToChat,
} from "~/services/ir/codecs/messages-chat/request"
import type { IRStop, IRUsage, StreamEvent } from "~/services/ir/types"
import { mergeUsage } from "~/services/ir/usage"
import type {
  ChatCompletionChunk,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"

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

function toChatStop(
  stop?: IRStop,
): ChatCompletionChunk["choices"][number]["finish_reason"] {
  if (stop?.reason === "max_tokens") return "length"
  if (stop?.reason === "tool_calls") return "tool_calls"
  if (stop?.reason === "refusal" && stop.raw === "content_filter")
    return "content_filter"
  return "stop"
}

/** Converts OpenAI SSE chunks to incremental semantic events. */
export async function* decodeChatStream(
  stream: AsyncIterable<CopilotStreamEvent>,
): AsyncIterable<StreamEvent> {
  let started = false
  let index = 0
  let open: { id: string; index: number; type: "text" | "thinking" } | undefined
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
          cacheWrite1hTokens:
            chunk.usage.prompt_tokens_details?.cache_creation
              ?.ephemeral_1h_input_tokens,
          reasoningTokens:
            chunk.usage.completion_tokens_details?.reasoning_tokens,
        },
      }
    for (const choice of chunk.choices) {
      const delta = choice.delta
      const images = [
        ...(delta.images ?? []),
        ...(Array.isArray(delta.content) ?
          delta.content.filter((part) => part.type === "image_url")
        : []),
      ]
      for (const image of images) {
        const previous = close()
        if (previous) yield previous
        const imageIndex = index++
        const partId = `image_${imageIndex}`
        yield {
          type: "part_start",
          index: imageIndex,
          partId,
          part: imageFromChat(image.image_url.url, image.image_url.detail),
        }
        yield { type: "part_end", index: imageIndex, partId }
      }
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
      const content =
        typeof delta.content === "string" ?
          delta.content
        : delta.content
            ?.filter(
              (part) => part.type === "text" || part.type === "output_text",
            )
            .map((part) => part.text)
            .join("")
      if (content) {
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
          delta: { type: "text", text: content },
        }
      }
      for (const call of delta.tool_calls ?? []) {
        if (!tools.has(call.index) && (call.id || call.function?.name)) {
          const previous = close()
          if (previous) yield previous
          const id = `tool_${index}`
          const toolIndex = index++
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
  for (const tool of tools.values())
    yield { type: "part_end", partId: tool.id, index: tool.index }
  yield {
    type: "message_end",
    stop: stop ?? { reason: "incomplete" },
    status: stop ? "completed" : "incomplete",
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
  let nextImage = 0
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
  try {
    for await (const event of stream) {
      if (event.type === "message_start") {
        id = event.id
        model = event.model
        created = event.createdAt ?? Math.floor(Date.now() / 1000)
        yield {
          data: JSON.stringify(chunk({ role: "assistant", content: "" })),
        }
      } else if (
        event.type === "part_start"
        && event.part.type === "tool_call"
      ) {
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
      } else if (event.type === "part_start" && event.part.type === "image") {
        yield {
          data: JSON.stringify(
            chunk({
              images: [{ ...imageToChat(event.part), index: nextImage++ }],
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
            data: JSON.stringify(
              chunk({ reasoning_content: event.delta.text }),
            ),
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
        usage = mergeUsage(usage, event.usage)
      } else if (event.type === "message_end") {
        if (
          event.status === "incomplete"
          && event.stop?.reason !== "max_tokens"
        )
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
          cache_creation: cacheCreationFor1h(
            usage?.cacheWriteTokens,
            usage?.cacheWrite1hTokens,
          ),
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
        throw new Error(
          `Anthropic upstream stream error: ${event.error.message}`,
        )
      }
    }
  } catch (error) {
    if (usage)
      yield {
        data: JSON.stringify({
          ...chunk({}),
          choices: [],
          usage: {
            prompt_tokens: usage.inputTokens ?? 0,
            completion_tokens: usage.outputTokens ?? 0,
            total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            prompt_tokens_details: {
              cached_tokens: usage.cacheReadTokens,
              cache_creation_input_tokens: usage.cacheWriteTokens,
              cache_creation: cacheCreationFor1h(
                usage.cacheWriteTokens,
                usage.cacheWrite1hTokens,
              ),
            },
          },
        }),
      }
    throw error
  }
  if (!ended) yield { data: JSON.stringify(chunk({}, "stop")) }
  yield { data: "[DONE]" }
}
