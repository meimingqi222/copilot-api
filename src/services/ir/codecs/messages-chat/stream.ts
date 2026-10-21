import { cacheCreationFor1h } from "~/lib/cache-usage"
import type { CacheCreationUsage } from "~/lib/cache-usage"
import type { AnthropicStreamEventData } from "~/services/protocols/anthropic/types"
import type {
  IRPart,
  IRPartDelta,
  IRStop,
  IRUsage,
  StreamEvent,
} from "~/services/ir/types"

import { sanitizeId } from "~/lib/id-sanitizer"
import { mergeUsage } from "~/services/ir/usage"
import { MESSAGES_IMAGE_OUTPUT_ERROR } from "~/services/ir/image-generation"
import { openAIUsageToAnthropic } from "~/lib/usage-translation"

export { decodeChatStream, encodeChatStream } from "./chat-stream"

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
      cache_creation?: CacheCreationUsage
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
    cache_creation?: CacheCreationUsage
  }
  error?: { type?: string; message?: string; code?: number; status?: number }
}

function messagesUsage(
  usage: NonNullable<MessagesEventLike["usage"]>,
): IRUsage {
  return {
    source: "reported",
    cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens,
    ...(usage.input_tokens !== undefined && {
      inputTokens: usage.input_tokens,
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
  // Keep Anthropic's NET input until all separately reported cache fields
  // have been merged; only then normalize to IR's inclusive input.
  let netUsage: IRUsage | undefined
  const updateUsage = (
    next: NonNullable<MessagesEventLike["usage"]>,
  ): IRUsage => {
    netUsage = mergeUsage(netUsage, messagesUsage(next))
    const inputTokens =
      (netUsage.inputTokens ?? 0)
      + (netUsage.cacheReadTokens ?? 0)
      + (netUsage.cacheWriteTokens ?? 0)
    return {
      ...netUsage,
      inputTokens,
      totalTokens: inputTokens + (netUsage.outputTokens ?? 0),
    }
  }
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
        yield { type: "usage", usage: updateUsage(event.message.usage) }
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
      if (event.usage) yield { type: "usage", usage: updateUsage(event.usage) }
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

/** Messages blocks are sequential, unlike interleaved Chat/Responses tools. */
async function* sequentialMessagesParts(
  stream: AsyncIterable<StreamEvent>,
): AsyncIterable<StreamEvent> {
  const pending = new Map<string, Array<StreamEvent>>()
  for await (const event of stream) {
    if (!("partId" in event)) {
      yield event
      if (event.type === "error") return
      continue
    }
    const queue = pending.get(event.partId) ?? []
    queue.push(event)
    pending.set(event.partId, queue)
    for (const [id, events] of pending) {
      const complete = events.at(-1)?.type === "part_end"
      yield* events
      events.length = 0
      if (!complete) break
      pending.delete(id)
    }
  }
}

/** Streams the active block immediately; only overlapping blocks are queued. */
export async function* encodeMessagesStream(
  stream: AsyncIterable<StreamEvent>,
  estimatedInputTokens = 0,
): AsyncIterable<AnthropicStreamEventData> {
  let usage: IRUsage | undefined
  let started = false
  let ended = false
  const messagesThinking = new Set<string>()
  const usageDelta = (): AnthropicStreamEventData => ({
    type: "message_delta",
    delta: {},
    usage: openAIUsageToAnthropic({
      prompt_tokens: usage?.inputTokens ?? estimatedInputTokens,
      completion_tokens: usage?.outputTokens ?? 0,
      prompt_tokens_details: {
        cached_tokens: usage?.cacheReadTokens,
        cache_creation_input_tokens: usage?.cacheWriteTokens,
        cache_creation: cacheCreationFor1h(
          usage?.cacheWriteTokens,
          usage?.cacheWrite1hTokens,
        ),
      },
    }),
  })
  try {
    for await (const event of sequentialMessagesParts(stream)) {
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
          if (part.source.wire !== "gemini") messagesThinking.add(event.partId)
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
          if (
            messagesThinking.has(event.partId)
            && part.signature
            && part.signedText === part.text
          )
            yield {
              type: "content_block_delta",
              index: event.index,
              delta: { type: "signature_delta", signature: part.signature },
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
        } else if (part.type === "image") {
          yield {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: MESSAGES_IMAGE_OUTPUT_ERROR,
            },
          }
          return
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
        else if (delta.type === "signature") {
          if (messagesThinking.has(event.partId))
            yield {
              type: "content_block_delta",
              index: event.index,
              delta: { type: "signature_delta", signature: delta.text },
            }
        } else
          yield {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "input_json_delta", partial_json: delta.text },
          }
      } else if (event.type === "part_end") {
        messagesThinking.delete(event.partId)
        yield { type: "content_block_stop", index: event.index }
      } else if (event.type === "usage") {
        usage = mergeUsage(usage, event.usage)
      } else if (event.type === "message_end") {
        ended = true
        if (
          event.status === "incomplete"
          && event.stop?.reason !== "max_tokens"
        ) {
          if (usage) yield usageDelta()
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
            cache_creation: cacheCreationFor1h(
              usage?.cacheWriteTokens,
              usage?.cacheWrite1hTokens,
            ),
          },
        })
        yield {
          type: "message_delta",
          delta: {
            stop_reason: toMessagesStop(event.stop),
            stop_sequence: null,
          },
          usage: {
            input_tokens: converted.input_tokens,
            output_tokens: converted.output_tokens,
            cache_read_input_tokens: converted.cache_read_input_tokens,
            cache_creation_input_tokens: converted.cache_creation_input_tokens,
            cache_creation: converted.cache_creation,
          },
        }
        yield { type: "message_stop" }
      } else if (event.type === "error") {
        ended = true
        if (usage) yield usageDelta()
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
  } catch (error) {
    // Preserve reported consumption even if a later upstream round throws.
    if (usage) yield usageDelta()
    throw error
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
